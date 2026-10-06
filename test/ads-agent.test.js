import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCampaigns, calculateCampaignMetrics, evaluateCampaign } from '../ads-agent.js';

test('menghitung CAC, ROAS, CTR, dan CPC secara deterministik', () => {
  const metrics = calculateCampaignMetrics({ id: 'a', name: 'A', spend: 90000, purchases: 3, revenue: 399000, impressions: 10000, clicks: 250 });
  assert.equal(metrics.cac, 30000);
  assert.ok(Math.abs(metrics.roas - 4.433333333333333) < 1e-12);
  assert.equal(metrics.ctr, 0.025);
  assert.equal(metrics.cpc, 360);
});

test('scale hanya direkomendasikan jika data purchase mencukupi', () => {
  const good = calculateCampaignMetrics({ spend: 90000, purchases: 3, revenue: 399000 });
  const thin = calculateCampaignMetrics({ spend: 30000, purchases: 1, revenue: 99000 });
  assert.equal(evaluateCampaign(good).qualifiesForScale, true);
  assert.equal(evaluateCampaign(thin).qualifiesForScale, false);
});

test('campaign tanpa purchase setelah spend threshold mendapat rekomendasi pause', () => {
  const metrics = calculateCampaignMetrics({ spend: 100000, purchases: 0 });
  const decision = evaluateCampaign(metrics);
  assert.equal(decision.actions[0].type, 'PAUSE_RECOMMENDATION');
});

test('analysis selalu read-only dan mengembalikan schema stabil', () => {
  const result = analyzeCampaigns([{ id: 'a', spend: 90000, purchases: 3, revenue: 399000 }]);
  assert.equal(result.schema, 'quorvante.ads-analysis.v1');
  assert.equal(result.safety.executionAllowed, false);
  assert.equal(result.totals.cac, 30000);
});
