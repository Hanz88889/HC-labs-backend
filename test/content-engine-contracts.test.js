import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContentPlanV1, validateTaskSpec } from '../task-spec.js';
import { buildContentBlueprint } from '../content-blueprint.js';
import { compilePrompt } from '../prompt-compiler.js';

const imagePlan = {
  schema: 'hclabs.content-plan.v1', goal: 'image', format: 'Social-ready', tone: 'Premium',
  creative_direction: 'Clean product composition', generation_prompt: 'product shot',
  generation: { mode: 'text-to-image', aspect_ratio: '1:1', camera_motion: 'stable' }, scenes: [],
};

const videoPlan = {
  ...imagePlan, goal: 'video', duration_seconds: 15,
  generation: { mode: 'text-to-video', aspect_ratio: '9:16', camera_motion: 'slow push-in' },
  scenes: [1, 2, 3].map((id) => ({ id, duration: 5, objective: 'scene' })),
};

test('normalizes v1 image plan into canonical Task Spec V2', () => {
  const spec = normalizeContentPlanV1(imagePlan);
  assert.equal(spec.schema, 'hclabs.task-spec.v2');
  assert.equal(spec.mode, 'text-to-image');
  assert.equal(spec.aspect_ratio, '1:1');
  assert.doesNotThrow(() => validateTaskSpec(spec));
});

test('builds a 15-second UGC blueprint with exact segment total', () => {
  const spec = normalizeContentPlanV1(videoPlan);
  const blueprint = buildContentBlueprint(spec, 'UGC_REVIEW_15S');
  assert.equal(blueprint.duration_seconds, 15);
  assert.deepEqual(blueprint.segments.map((s) => s.duration), [3, 8, 4]);
});

test('compiles deterministic modules and model output contract', () => {
  const spec = normalizeContentPlanV1(imagePlan);
  const blueprint = buildContentBlueprint(spec);
  const compiled = compilePrompt(spec, blueprint, { modelId: 'model-test', moduleOrder: ['subject', 'visual', 'camera'] });
  assert.equal(compiled.schema, 'hclabs.compiled-prompt.v1');
  assert.equal(compiled.model_id, 'model-test');
  assert.deepEqual(compiled.modules, ['subject', 'visual', 'camera']);
  assert.match(compiled.prompt, /SUBJECT:/);
});
