import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutputContract, validateStoredAsset } from '../output-validator.js';

test('output contract passes a valid image result', () => {
  const result = validateOutputContract({
    flow: 't2i', url: 'https://provider.example/image.png', prompt: 'a red fox in snow',
    providerData: { images: [{ url: 'https://provider.example/image.png' }] },
  });
  assert.equal(result.status, 'PASS');
});

test('output contract rejects blocked or malformed content', () => {
  const result = validateOutputContract({
    flow: 'i2v', url: 'not-a-url', prompt: '',
    providerData: { safety: { blocked: true } }, durationSeconds: 5,
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.details.failures.includes('OUTPUT_URL_INVALID'));
  assert.ok(result.details.failures.includes('CONTENT_POLICY_BLOCKED'));
});

test('stored asset gate requires expected media type and non-zero bytes', () => {
  assert.equal(validateStoredAsset({ contentType: 'video/mp4', expectedKind: 'video', bytes: 10 }).status, 'PASS');
  assert.equal(validateStoredAsset({ contentType: 'text/html', expectedKind: 'video', bytes: 10 }).status, 'FAIL');
  assert.equal(validateStoredAsset({ contentType: 'image/png', expectedKind: 'image', bytes: 0 }).status, 'FAIL');
});
