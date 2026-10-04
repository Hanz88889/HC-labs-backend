import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModelForFlow, modelRoutingMatrix } from '../model-router.js';
import { PRE_QC_BENCHMARK_MATRIX, validateBenchmarkCase } from '../benchmark-matrix.js';

function license(tier, premiumUsage) {
  return { entry: { tier, premiumUsage: { [premiumUsage.flow]: premiumUsage.count } } };
}

test('pre-QC benchmark matrix passes all tier boundaries', () => {
  for (const item of PRE_QC_BENCHMARK_MATRIX) {
    const result = selectModelForFlow({ license: license(item.tier, { flow: item.flow, count: item.premiumUsage }), flow: item.flow });
    assert.equal(validateBenchmarkCase(result, item), true, item.id);
  }
});

test('router honors explicit engine pair for compatibility', () => {
  const custom = { premium: { id: 'custom/premium' }, budget: { id: 'custom/budget' } };
  const result = selectModelForFlow({ license: license('STD', { flow: 't2i', count: 10 }), flow: 't2i', enginePair: custom });
  assert.equal(result.modelCfg.id, 'custom/budget');
});

test('routing matrix covers all production flow keys', () => {
  assert.deepEqual(modelRoutingMatrix().map((item) => item.flow), ['t2i', 'i2i', 't2v', 'i2v']);
});
