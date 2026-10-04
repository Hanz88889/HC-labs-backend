import test from 'node:test';
import assert from 'node:assert/strict';
import { listCapabilities, routeTaskSpec } from '../capability-registry.js';

function spec(mode, references = [], modelRequirements = []) {
  return { schema: 'hclabs.task-spec.v2', mode, references, model_requirements: modelRequirements };
}

test('routes text-to-image to image engine', () => {
  const route = routeTaskSpec(spec('text-to-image'));
  assert.equal(route.supported, true);
  assert.equal(route.flow, 't2i');
  assert.equal(route.reference_strategy, 'none');
});

test('routes multiple references to contact-sheet i2v strategy', () => {
  const route = routeTaskSpec(spec('reference-to-video', ['a', 'b']));
  assert.equal(route.supported, true);
  assert.equal(route.flow, 'i2v');
  assert.equal(route.reference_strategy, 'contact-sheet');
});

test('rejects unsupported video-to-video explicitly', () => {
  const route = routeTaskSpec(spec('video-to-video'));
  assert.deepEqual(route, { supported: false, reason: 'UNSUPPORTED_CAPABILITY', mode: 'video-to-video' });
});

test('lists every canonical generation mode without provider secrets', () => {
  const modes = listCapabilities();
  assert.deepEqual(modes.map((item) => item.mode), [
    'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'reference-to-video', 'video-to-video',
  ]);
  assert.equal(modes.some((item) => item.model), false);
});
