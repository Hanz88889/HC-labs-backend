import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertModelRegistry, recordModelCapability, recordModelPricing, recordCostRecord } from '../d1-store.js';
import { runPreQcHarness } from '../pre-qc-harness.js';
import { buildModelRegistrySeed } from '../model-registry-seed.js';

function mockDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return { bind() { return { async run() { return { meta: { changes: 1 } }; } }; } };
    },
  };
}

test('persists model capability and cost contracts through D1 adapter', async () => {
  const db = mockDb();
  const env = { HC_DB: db };
  assert.equal(await upsertModelRegistry(env, { modelKey: 'wan-i2v', provider: 'fal', modelId: 'fal-ai/wan-i2v', label: 'Motion' }), true);
  assert.equal(await recordModelCapability(env, { modelKey: 'wan-i2v', name: 'image_reference' }), true);
  assert.equal(await recordModelPricing(env, { modelKey: 'wan-i2v', pricingKey: 'request', amountUsd: 0.2 }), true);
  assert.equal(await recordCostRecord(env, { jobId: 'j1', attemptId: 'a1', provider: 'fal', estimatedCostUsd: 0.2 }), true);
  assert.equal(db.calls.filter((sql) => /model_registry|model_capabilities|model_pricing|cost_records/.test(sql)).length, 4);
});

test('offline pre-QC harness passes without provider calls', () => {
  const report = runPreQcHarness();
  assert.equal(report.mode, 'offline-no-provider-call');
  assert.equal(report.ok, true);
  assert.equal(report.passed, report.total);
  assert.equal(report.total, 8);
});

test('model registry seed covers four flows and both tiers', () => {
  const seed = buildModelRegistrySeed();
  assert.equal(seed.length, 8);
  assert.equal(new Set(seed.map((item) => item.model.modelKey.split('-').slice(0, -1).join('-'))).size, 4);
  assert.equal(seed.every((item) => item.pricing.amountUsd > 0), true);
});
