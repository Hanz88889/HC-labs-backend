import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../brain-router.js';

const base = {
  schema: 'hclabs.content-plan.v1',
  format: 'Social-ready',
  tone: 'Premium & warm',
  creative_direction: 'Clean product composition',
  generation_prompt: 'A premium product on a warm studio set',
  duration_seconds: null,
  generation: { mode: 'text-to-image', aspect_ratio: '1:1', camera_motion: '' },
  scenes: [],
};

test('validates image plan and attaches conversation id', () => {
  const plan = validatePlan({ ...base, goal: 'image' }, { conversation_id: 'conv-test' });
  assert.equal(plan.conversation_id, 'conv-test');
});

test('validates edit mode separately from image mode', () => {
  const plan = validatePlan({
    ...base,
    goal: 'edit',
    generation: { ...base.generation, mode: 'image-to-image' },
  }, { conversation_id: 'conv-edit' });
  assert.equal(plan.generation.mode, 'image-to-image');
});

test('requires exactly three video scenes totaling fifteen seconds', () => {
  const video = {
    ...base,
    goal: 'video',
    duration_seconds: 15,
    generation: { ...base.generation, mode: 'text-to-video', aspect_ratio: '16:9' },
    scenes: [1, 2, 3].map(id => ({ id, objective: 'scene', visual: 'visual', camera: 'camera', lighting: 'soft', motion: 'slow', duration: 5, prompt: 'prompt' })),
  };
  assert.equal(validatePlan(video, { conversation_id: 'conv-video' }).scenes.length, 3);
});

test('rejects a video plan with incorrect duration', () => {
  const video = {
    ...base,
    goal: 'video',
    generation: { ...base.generation, mode: 'text-to-video', aspect_ratio: '16:9' },
    scenes: [1, 2, 3].map(id => ({ id, duration: 4 })),
  };
  assert.throws(() => validatePlan(video, { conversation_id: 'conv-bad' }), /15 detik/);
});

test('rejects a mismatched generation mode', () => {
  assert.throws(() => validatePlan({ ...base, goal: 'image', generation: { ...base.generation, mode: 'text-to-video' } }, { conversation_id: 'conv-mode' }), /mode tidak sesuai/);
});
