import test from 'node:test';
import assert from 'node:assert/strict';
import { persistGeneratedAsset } from '../asset-store.js';

test('persists a streamed image and returns an internal asset URL', async () => {
  const objects = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
  try {
    const env = {
      HC_ASSETS: {
        async put(key, value, options) {
          objects.set(key, { value, options });
          const reader = value.getReader();
          while (!(await reader.read()).done) { /* consume stream */ }
        },
      },
    };
    const result = await persistGeneratedAsset(env, {
      flow: 't2i', jobId: 'JOB-1', attemptId: 'ATT-1', sourceUrl: 'https://provider.test/a.png',
    });
    assert.equal(result.ok, true);
    assert.equal(result.bytes, 3);
    assert.equal(result.internalUrl, `/api/assets/${encodeURIComponent(result.key)}`);
    assert.equal(objects.get(result.key).options.httpMetadata.contentType, 'image/png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a provider response whose media type does not match the flow', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>bad</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  try {
    const result = await persistGeneratedAsset({ HC_ASSETS: { put() {} } }, {
      flow: 't2v', jobId: 'JOB-1', attemptId: 'ATT-1', sourceUrl: 'https://provider.test/a.mp4',
    });
    assert.deepEqual(result, { ok: false, reason: 'SOURCE_MEDIA_TYPE_MISMATCH', contentType: 'text/html' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
