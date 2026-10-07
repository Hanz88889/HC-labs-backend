import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.js';
import { persistGeneratedAsset } from '../asset-store.js';

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
  196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

function strictBucket(allowedBodies) {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      if (value instanceof ReadableStream && !allowedBodies.has(value)) {
        throw new TypeError('Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)');
      }
      const data = value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value;
      objects.set(key, { data, options });
    },
    async get(key) {
      const found = objects.get(key);
      return found ? { body: found.data, httpMetadata: found.options?.httpMetadata } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

function withTimeout(promise, ms = 2000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('HANG')), ms))]);
}

async function persistWith(headers, bodyBytes, bucketFactory = strictBucket) {
  const original = globalThis.fetch;
  const allowed = new WeakSet();
  const bucket = bucketFactory(allowed);
  globalThis.fetch = async () => {
    const response = new Response(bodyBytes, { status: 200, headers });
    allowed.add(response.body);
    return response;
  };
  try {
    const result = await withTimeout(persistGeneratedAsset({ HC_ASSETS: bucket }, {
      flow: 't2i', jobId: 'J', attemptId: 'A', sourceUrl: 'https://cdn.test/a.png',
    }));
    return { result, bucket };
  } finally { globalThis.fetch = original; }
}

test('R2 store works when the source advertises its length', async () => {
  const { result, bucket } = await persistWith({ 'content-type': 'image/png', 'content-length': String(PNG.byteLength) }, PNG);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, PNG.byteLength);
  assert.equal(new Uint8Array(bucket.objects.get(result.key).data).byteLength, PNG.byteLength);
  assert.match(result.key, /^generated\/J\/A\.png$/);
});

test('R2 store works when the source does not advertise a length', async () => {
  const { result, bucket } = await persistWith({ 'content-type': 'image/png' }, PNG);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, PNG.byteLength);
  assert.equal(bucket.objects.size, 1);
});

test('R2 failure returns an error promptly instead of hanging', async () => {
  const failing = () => ({ async put() { throw new Error('R2 down'); } });
  const { result } = await persistWith({ 'content-type': 'image/png', 'content-length': '10' }, PNG, failing);
  assert.deepEqual([result.ok, result.reason], [false, 'R2_PUT_FAILED']);
  const second = await persistWith({ 'content-type': 'image/png' }, PNG, failing);
  assert.deepEqual([second.result.ok, second.result.reason], [false, 'R2_PUT_FAILED']);
});

test('oversized advertised length is rejected before any upload', async () => {
  const { result, bucket } = await persistWith({ 'content-type': 'image/png', 'content-length': String(300 * 1024 * 1024) }, PNG);
  assert.deepEqual([result.ok, result.reason], [false, 'SOURCE_ASSET_TOO_LARGE']);
  assert.equal(bucket.objects.size, 0);
});

function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const wrap = (text) => {
    const statement = { text, params: [] };
    statement.bind = (...params) => { statement.params = params; return statement; };
    statement.run = async () => ({ success: true, meta: { changes: Number(sql.prepare(text).run(...statement.params).changes) } });
    statement.first = async () => sql.prepare(text).get(...statement.params) || null;
    statement.all = async () => ({ results: sql.prepare(text).all(...statement.params) });
    return statement;
  };
  return {
    sql,
    prepare: wrap,
    async batch(list) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const statement of list) out.push(await statement.run());
        sql.exec('COMMIT');
        return out;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
}

function falFetch(calls) {
  return async (url, options = {}) => {
    const target = String(url);
    calls.push(`${options.method || 'GET'} ${target}`);
    if (target.startsWith('https://queue.fal.run') && options.method === 'POST') return new Response(JSON.stringify({ request_id: 'r1' }));
    if (target.includes('/status')) return new Response(JSON.stringify({ status: 'COMPLETED' }));
    if (target.includes('/requests/r1')) return new Response(JSON.stringify({ images: [{ url: 'https://v3.fal.media/x.png', content_type: 'image/png' }] }));
    if (target.startsWith('https://v3.fal.media')) {
      return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) } });
    }
    return new Response('{}', { status: 404 });
  };
}

test('image generation completes end to end with a strict R2 and settles the credit', async () => {
  const db = sqliteD1();
  const kv = new Map();
  const allowed = new WeakSet();
  const bucket = strictBucket(allowed);
  const env = {
    HC_DB: db, FAL_KEY: 'x',
    LICENSE_KV: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    HC_ASSETS: bucket,
  };
  db.sql.prepare("INSERT INTO licenses (license_key,email,tier,status,credits_image,credits_video,limit_value,bound_at) VALUES ('K1','a@b.c','pro','active',300,90,390,?)")
    .run(new Date().toISOString());
  const original = globalThis.fetch;
  const calls = [];
  const baseFetch = falFetch(calls);
  globalThis.fetch = async (url, options) => {
    const response = await baseFetch(url, options);
    if (response.body) allowed.add(response.body);
    return response;
  };
  try {
    const res = await withTimeout(worker.fetch(new Request('https://api.test/api/images/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': 'K1', 'X-License-Email': 'a@b.c', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ prompt: 'kucing oranye', model: 'auto', size: '9:16', negative: '' }),
    }), env), 5000);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.type, 'url');
    assert.match(data.url, /^\/api\/assets\/generated%2F/);
    assert.equal(bucket.objects.size, 1);
    const job = db.sql.prepare('SELECT status FROM generation_jobs').get();
    assert.equal(job.status, 'COMPLETED');
    const balance = db.sql.prepare("SELECT available_units a, reserved_units r, committed_units c FROM quota_balances WHERE credit_type = 'image'").get();
    assert.deepEqual({ ...balance }, { a: 299, r: 0, c: 1 });
  } finally { globalThis.fetch = original; }
});
