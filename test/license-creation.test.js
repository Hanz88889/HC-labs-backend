import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.js';
import { licenseEntryToRow } from '../d1-store.js';

function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const wrap = (text) => {
    const statement = { text, params: [] };
    statement.bind = (...params) => { statement.params = params; return statement; };
    statement.run = async () => {
      const info = sql.prepare(text).run(...statement.params);
      return { success: true, meta: { changes: Number(info.changes) } };
    };
    statement.first = async () => sql.prepare(text).get(...statement.params) || null;
    statement.all = async () => ({ results: sql.prepare(text).all(...statement.params) });
    return statement;
  };
  return {
    sql,
    prepare: wrap,
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        sql.exec('COMMIT');
        return out;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const SECRET = 'rahasia-admin-panjang';

const PANEL_ENTRY = {
  license_key: 'HCLABS-PRO-JVTAR6',
  email: null,
  tier: 'pro',
  credits: { image: 300, video: 90 },
  limit: { image: 300, video: 90 },
  status: 'unbound',
  bound_at: null,
  reset_date: '2026-10-01',
};

function panelBody(key = 'HCLABS-PRO-JVTAR6') {
  return [{ key, value: JSON.stringify({ ...PANEL_ENTRY, license_key: key }) }];
}

function kvStore(putImpl) {
  const store = new Map();
  return {
    store,
    binding: {
      async get(k) { return store.get(k) ?? null; },
      async put(k, v) { if (putImpl) return putImpl(k, v); store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
  };
}

function bulkRequest(ip, body, headers = { 'X-Admin-Secret': SECRET }) {
  return new Request('https://api.test/api/admin/bulk-import', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function activateRequest(ip, key, email) {
  return new Request('https://api.test/api/activate', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, email }),
  });
}

function statusRequest(ip, key, email) {
  return new Request('https://api.test/api/license/status', {
    headers: { 'CF-Connecting-IP': ip, 'X-License-Key': key, 'X-License-Email': email },
  });
}

test('licenseEntryToRow accepts the object limit the panel sends', () => {
  assert.equal(licenseEntryToRow('K', PANEL_ENTRY).limit_value, 390);
  assert.equal(licenseEntryToRow('K', { ...PANEL_ENTRY, limit: 30 }).limit_value, 30);
  assert.equal(licenseEntryToRow('K', { ...PANEL_ENTRY, limit: undefined }).limit_value, 0);
  assert.equal(licenseEntryToRow('K', { ...PANEL_ENTRY, limit: { image: 'x', video: 5 } }).limit_value, 5);
});

test('license from the panel can be created, activated and used end to end', async () => {
  const db = sqliteD1();
  const kv = kvStore();
  const env = { HC_DB: db, hc_kv: kv.binding, ADMIN_SECRET: SECRET };
  const created = await worker.fetch(bulkRequest('20.0.0.1', panelBody()), env);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).imported, 1);
  const activated = await worker.fetch(activateRequest('20.0.0.2', 'HCLABS-PRO-JVTAR6', 'pembeli@mail.test'), env);
  assert.equal(activated.status, 200);
  const status = await worker.fetch(statusRequest('20.0.0.2', 'HCLABS-PRO-JVTAR6', 'pembeli@mail.test'), env);
  assert.equal(status.status, 200);
  const row = db.sql.prepare('SELECT email, status, credits_image, credits_video FROM licenses WHERE license_key = ?').get('HCLABS-PRO-JVTAR6');
  assert.deepEqual({ ...row }, { email: 'pembeli@mail.test', status: 'active', credits_image: 300, credits_video: 90 });
});

test('bulk import never overwrites a license that already exists', async () => {
  const db = sqliteD1();
  const env = { HC_DB: db, hc_kv: kvStore().binding, ADMIN_SECRET: SECRET };
  await worker.fetch(bulkRequest('20.0.0.3', panelBody('HCLABS-DUP-1')), env);
  await worker.fetch(activateRequest('20.0.0.4', 'HCLABS-DUP-1', 'a@mail.test'), env);
  const again = await (await worker.fetch(bulkRequest('20.0.0.3', panelBody('HCLABS-DUP-1')), env)).json();
  assert.deepEqual([again.imported, again.skipped], [0, 1]);
  assert.equal(db.sql.prepare('SELECT email FROM licenses WHERE license_key = ?').get('HCLABS-DUP-1').email, 'a@mail.test');
});

test('bulk import succeeds when only the KV write fails', async () => {
  const db = sqliteD1();
  const kv = kvStore(async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); });
  const env = { HC_DB: db, hc_kv: kv.binding, ADMIN_SECRET: SECRET };
  const res = await worker.fetch(bulkRequest('20.0.0.5', panelBody('HCLABS-KVFAIL-1')), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).imported, 1);
});

test('bulk import reports the real reason instead of a bare 500', async () => {
  const kv = kvStore(async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); });
  const env = { hc_kv: kv.binding, ADMIN_SECRET: SECRET };
  const res = await worker.fetch(bulkRequest('20.0.0.6', panelBody('HCLABS-BOTHFAIL-1')), env);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /KV PUT failed/);
});

test('bulk import accepts object values and the items wrapper', async () => {
  const db = sqliteD1();
  const kv = kvStore();
  const env = { HC_DB: db, hc_kv: kv.binding, ADMIN_SECRET: SECRET };
  const res = await worker.fetch(bulkRequest('20.0.0.7', { items: [{ key: 'HCLABS-OBJ-1', value: PANEL_ENTRY }] }), env);
  assert.equal(res.status, 200);
  assert.equal(typeof kv.store.get('HCLABS-OBJ-1'), 'string');
});

test('worker still works when the KV namespace is bound as LICENSE_KV', async () => {
  const db = sqliteD1();
  const kv = kvStore();
  const env = { HC_DB: db, LICENSE_KV: kv.binding, ADMIN_SECRET: SECRET };
  const created = await worker.fetch(bulkRequest('20.0.0.8', panelBody('HCLABS-ALIAS-1')), env);
  assert.equal(created.status, 200);
  assert.equal(kv.store.has('HCLABS-ALIAS-1'), true);
  const health = await worker.fetch(new Request('https://api.test/api/health'), env);
  assert.equal((await health.json()).kvReady, true);
});

test('without any KV binding an unknown key fails loudly instead of being treated as invalid', async () => {
  const db = sqliteD1();
  const env = { HC_DB: db, ADMIN_SECRET: SECRET };
  const res = await worker.fetch(statusRequest('20.0.0.9', 'HCLABS-NOPE', 'x@mail.test'), env);
  assert.equal(res.status, 500);
});
