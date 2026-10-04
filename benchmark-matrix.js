export const PRE_QC_BENCHMARK_MATRIX = Object.freeze([
  { id: 'route-t2i-premium', flow: 't2i', tier: 'STD', premiumUsage: 0, expectedTier: 'premium' },
  { id: 'route-t2i-budget-after-threshold', flow: 't2i', tier: 'STD', premiumUsage: 10, expectedTier: 'budget' },
  { id: 'route-pro-extended-premium', flow: 'i2v', tier: 'PRO', premiumUsage: 29, expectedTier: 'premium' },
  { id: 'route-pro-budget-after-threshold', flow: 'i2v', tier: 'PRO', premiumUsage: 30, expectedTier: 'budget' },
  { id: 'route-video-text', flow: 't2v', tier: 'STD', premiumUsage: 0, expectedTier: 'premium' },
  { id: 'route-image-edit', flow: 'i2i', tier: 'STANDARD', premiumUsage: 10, expectedTier: 'budget' },
]);

export function validateBenchmarkCase(result, benchmarkCase) {
  const actualTier = result.usePremium ? 'premium' : 'budget';
  return actualTier === benchmarkCase.expectedTier && result.flow === benchmarkCase.flow;
}
