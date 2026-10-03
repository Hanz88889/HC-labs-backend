import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoInput, pollFalOnce, videoFramesForDuration } from '../fal-client.js';

test('maps requested duration to Wan frame count', () => {
  assert.equal(videoFramesForDuration(5, 16), 81);
  assert.equal(videoFramesForDuration(8, 16), 129);
  assert.equal(videoFramesForDuration(10, 16), 161);
});

test('builds Wan payload with requested duration and ratio', () => {
  const payload = buildVideoInput(
    { id: 'fal-ai/wan-i2v', family: 'wan' },
    { prompt: 'natural product motion', image: 'https://example.com/ref.png', ratio: '9:16', duration: 8 },
  );

  assert.deepEqual(payload, {
    prompt: 'natural product motion',
    resolution: '480p',
    aspect_ratio: '9:16',
    num_frames: 129,
    frames_per_second: 16,
    image_url: 'https://example.com/ref.png',
  });
});

test('treats terminal provider failure as error instead of indefinite pending', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'FAILED', error: 'provider failed' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const result = await pollFalOnce('fal-ai/wan-t2v', 'request-001', { FAL_KEY: 'test-key' });
    assert.equal(result.state, 'error');
    assert.match(result.error, /provider failed/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
