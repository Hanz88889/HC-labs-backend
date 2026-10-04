import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  reserveGenerationAtomic, settleGenerationAtomic, expireStaleGenerations, getD1QuotaBalances,
} from '../d1-store.js';
import worker from '../worker.js';
import { encodeTaskId } from '../fal-client.js';

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

function seed(db, keys = ['HC-A'], credits = 5) {
  for (const key of keys) {
    db.sql.prepare(
      "INSERT INTO licenses (license_key,email,tier,status,credits_image,credits_video,limit_value) VALUES (?,?,?,?,?,?,?)",
    ).run(key, `${key.toLowerCase()}@mail.test`, 'STD', 'active', credits, credits, 20);
  }
}

async function reserve(db, licenseKey, idempotencyKey, extra = {}) {
  return reserveGenerationAtomic({ HC_DB: db }, {
    licenseKey, idempotencyKey, flow: 't2v', provider: 'fal', modelId: 'm',
    maxActiveJobs: 2, creditType: 'video', ...extra,
  });
}

function balance(db, licenseKey = 'HC-A', type = 'video') {
  const row = db.sql.prepare(
    'SELECT available_units a, reserved_units r, committed_units c, released_units l FROM quota_balances WHERE license_key = ? AND credit_type = ?',
  ).get(licenseKey, type);
  return [row.a, row.r, row.c, row.l];
}

function settle(db, reservation, settlement, licenseKey = 'HC-A') {
  return settleGenerationAtomic({ HC_DB: db }, {
    licenseKey, jobId: reservation.jobId, attemptId: reservation.attemptId,
    creditType: 'video', settlement,
  });
}

test('RELEASE returns the credit to available balance', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-release-1');
  assert.deepEqual(balance(db), [4, 1, 0, 0]);
  assert.equal((await settle(db, r, 'RELEASE')).ok, true);
  assert.deepEqual(balance(db), [5, 0, 0, 1]);
});

test('COMMIT consumes the credit permanently', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-commit-1');
  assert.equal((await settle(db, r, 'COMMIT')).ok, true);
  assert.deepEqual(balance(db), [4, 0, 1, 0]);
});

test('a job cannot be settled twice with opposite outcomes', async () => {
  const db = sqliteD1(); seed(db);
  const a = await reserve(db, 'HC-A', 'key-double-a');
  const b = await reserve(db, 'HC-A', 'key-double-b');
  assert.equal((await settle(db, a, 'RELEASE')).ok, true);
  const second = await settle(db, a, 'COMMIT');
  assert.equal(second.ok, false);
  assert.deepEqual(balance(db), [4, 1, 0, 1]);
  assert.equal((await settle(db, b, 'COMMIT')).ok, true);
  assert.deepEqual(balance(db), [4, 0, 1, 1]);
});

test('repeating the same settlement is idempotent', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-repeat-1');
  assert.equal((await settle(db, r, 'RELEASE')).duplicate, false);
  const again = await settle(db, r, 'RELEASE');
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.deepEqual(balance(db), [5, 0, 0, 1]);
});

test('another license cannot settle or touch a job it does not own', async () => {
  const db = sqliteD1(); seed(db, ['HC-A', 'HC-B']);
  const r = await reserve(db, 'HC-A', 'key-owner-a');
  await reserve(db, 'HC-B', 'key-owner-b');
  const out = await settle(db, r, 'RELEASE', 'HC-B');
  assert.equal(out.ok, false);
  assert.deepEqual(balance(db, 'HC-A'), [4, 1, 0, 0]);
  assert.deepEqual(balance(db, 'HC-B'), [4, 1, 0, 0]);
});

test('idempotency key cannot be reused by another license or with another payload', async () => {
  const db = sqliteD1(); seed(db, ['HC-A', 'HC-B']);
  const first = await reserve(db, 'HC-A', 'key-shared-1', { requestHash: 'hash-1' });
  assert.equal(first.ok, true);
  const foreign = await reserve(db, 'HC-B', 'key-shared-1', { requestHash: 'hash-1' });
  assert.deepEqual([foreign.ok, foreign.reason], [false, 'IDEMPOTENCY_KEY_CONFLICT']);
  const changed = await reserve(db, 'HC-A', 'key-shared-1', { requestHash: 'hash-2' });
  assert.deepEqual([changed.ok, changed.reason], [false, 'IDEMPOTENCY_KEY_REUSED']);
  const same = await reserve(db, 'HC-A', 'key-shared-1', { requestHash: 'hash-1' });
  assert.deepEqual([same.ok, same.duplicate, same.jobId], [true, true, first.jobId]);
  assert.deepEqual(balance(db, 'HC-A'), [4, 1, 0, 0]);
});

test('active job limit and empty quota are enforced atomically', async () => {
  const db = sqliteD1(); seed(db, ['HC-A'], 1);
  const first = await reserve(db, 'HC-A', 'key-limit-1');
  assert.equal(first.ok, true);
  const second = await reserve(db, 'HC-A', 'key-limit-2');
  assert.equal(second.ok, false);
  assert.equal(balance(db)[1], 1);
});

test('reaper releases stale jobs and leaves fresh jobs alone', async () => {
  const db = sqliteD1(); seed(db);
  const stale = await reserve(db, 'HC-A', 'key-stale-1');
  const fresh = await reserve(db, 'HC-A', 'key-fresh-1');
  db.sql.prepare("UPDATE generation_jobs SET created_at = datetime('now','-2 hours') WHERE job_id = ?").run(stale.jobId);
  const out = await expireStaleGenerations({ HC_DB: db }, { olderThanSeconds: 900 });
  assert.deepEqual(out, { scanned: 1, released: 1, failed: 0 });
  assert.equal(db.sql.prepare('SELECT status FROM generation_jobs WHERE job_id = ?').get(stale.jobId).status, 'EXPIRED');
  assert.equal(db.sql.prepare('SELECT status FROM generation_jobs WHERE job_id = ?').get(fresh.jobId).status, 'RESERVED');
  assert.deepEqual(balance(db), [4, 1, 0, 1]);
  const again = await expireStaleGenerations({ HC_DB: db }, { olderThanSeconds: 900 });
  assert.equal(again.scanned, 0);
});

function licensedRequest(path, key, method = 'GET', body) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { 'X-License-Key': key, 'X-License-Email': `${key.toLowerCase()}@mail.test`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function workerEnv(db) {
  return { HC_DB: db, hc_kv: { async get() { return null; }, async put() {}, async delete() {} }, FAL_KEY: 'x' };
}

test('poll returns 404 for a job owned by another license', async () => {
  const db = sqliteD1(); seed(db, ['HC-A', 'HC-B']);
  const r = await reserve(db, 'HC-A', 'key-poll-owner');
  const token = encodeTaskId('video', 'm', 'req-1', { j: r.jobId, a: r.attemptId });
  const res = await worker.fetch(licensedRequest(`/api/videos/status/fal/${token}`, 'HC-B'), workerEnv(db));
  assert.equal(res.status, 404);
});

test('poll ignores forged model, request and credit type inside the token', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-poll-forged');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network blocked'); };
  try {
    const token = encodeTaskId('image', '../../evil/model', 'evil-request', { j: r.jobId, a: 'other-attempt' });
    const res = await worker.fetch(licensedRequest(`/api/videos/status/fal/${token}`, 'HC-A'), workerEnv(db));
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'in_progress');
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('poll on a completed job returns the stored result without calling the provider', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-poll-done');
  await settleGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-A', jobId: r.jobId, attemptId: r.attemptId, creditType: 'video',
    settlement: 'COMMIT', resultUrl: '/api/assets/generated%2Fx.mp4',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('provider must not be called'); };
  try {
    const token = encodeTaskId('video', 'm', 'req', { j: r.jobId, a: r.attemptId });
    const res = await worker.fetch(licensedRequest(`/api/videos/status/fal/${token}`, 'HC-A'), workerEnv(db));
    const data = await res.json();
    assert.deepEqual([data.done, data.url], [true, '/api/assets/generated%2Fx.mp4']);
  } finally { globalThis.fetch = originalFetch; }
});

test('poll on an expired job reports failure and does not resurrect it', async () => {
  const db = sqliteD1(); seed(db);
  const r = await reserve(db, 'HC-A', 'key-poll-expired');
  await settleGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-A', jobId: r.jobId, attemptId: r.attemptId, creditType: 'video',
    settlement: 'RELEASE', terminalStatus: 'EXPIRED',
  });
  const token = encodeTaskId('video', 'm', 'req', { j: r.jobId, a: r.attemptId });
  const res = await worker.fetch(licensedRequest(`/api/videos/status/fal/${token}`, 'HC-A'), workerEnv(db));
  const data = await res.json();
  assert.deepEqual([data.failed, data.status], [true, 'expired']);
  assert.deepEqual(balance(db), [5, 0, 0, 1]);
});

test('token without a job id is rejected as legacy without any provider call', async () => {
  const db = sqliteD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('provider must not be called'); };
  try {
    const token = encodeTaskId('video', 'm', 'req', {});
    const res = await worker.fetch(licensedRequest(`/api/videos/status/fal/${token}`, 'HC-A'), workerEnv(db));
    const data = await res.json();
    assert.equal(data.status, 'legacy_task_unsupported');
  } finally { globalThis.fetch = originalFetch; }
});

test('diagnostics requires a valid license', async () => {
  const db = sqliteD1(); seed(db);
  const anonymous = await worker.fetch(new Request('https://api.test/api/diagnostics', { method: 'POST' }), workerEnv(db));
  assert.equal(anonymous.status, 401);
});

test('stored asset route only serves keys under generated/', async () => {
  const db = sqliteD1();
  const env = {
    ...workerEnv(db),
    HC_ASSETS: { async get(key) { return { body: key, httpMetadata: { contentType: 'video/mp4' } }; } },
  };
  const blocked = await worker.fetch(new Request(`https://api.test/api/assets/${encodeURIComponent('other/secret.bin')}`), env);
  assert.equal(blocked.status, 404);
  const allowed = await worker.fetch(new Request(`https://api.test/api/assets/${encodeURIComponent('generated/j/a.mp4')}`), env);
  assert.equal(allowed.status, 200);
});

test('reserve stores quota balances readable through the status adapter', async () => {
  const db = sqliteD1(); seed(db);
  await reserve(db, 'HC-A', 'key-status-1');
  const balances = await getD1QuotaBalances({ HC_DB: db }, 'HC-A');
  assert.equal(balances.find((b) => b.credit_type === 'video').available_units, 4);
});
