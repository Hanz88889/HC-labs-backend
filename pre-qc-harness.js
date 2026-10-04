import { PRE_QC_BENCHMARK_MATRIX, validateBenchmarkCase } from './benchmark-matrix.js';
import { selectModelForFlow } from './model-router.js';
import { normalizeContentPlanV1 } from './task-spec.js';
import { buildContentBlueprint } from './content-blueprint.js';
import { compilePrompt } from './prompt-compiler.js';
import { validateOutputContract } from './output-validator.js';

function benchmarkLicense(item) {
  return { entry: { tier: item.tier, premiumUsage: { [item.flow]: item.premiumUsage } } };
}

export function runPreQcHarness() {
  const checks = [];
  for (const item of PRE_QC_BENCHMARK_MATRIX) {
    const result = selectModelForFlow({ license: benchmarkLicense(item), flow: item.flow });
    checks.push({ id: item.id, ok: validateBenchmarkCase(result, item) });
  }

  const plan = normalizeContentPlanV1({
    schema: 'hclabs.content-plan.v1', goal: 'video', format: 'UGC Review', tone: 'natural',
    creative_direction: 'authentic product review', generation_prompt: 'creator reviews product',
    duration_seconds: 15, generation: { mode: 'text-to-video', aspect_ratio: '9:16', camera_motion: 'handheld' },
    scenes: [1, 2, 3].map((id) => ({ id, objective: 'scene', duration: 5 })),
  });
  const blueprint = buildContentBlueprint(plan, 'UGC_REVIEW_15S');
  const compiled = compilePrompt(plan, blueprint);
  checks.push({ id: 'task-spec-blueprint-compiler', ok: Boolean(compiled.prompt && blueprint.segments.length === 3) });
  checks.push({ id: 'output-contract-negative', ok: validateOutputContract({ flow: 't2v', url: 'not-a-url' }).status === 'FAIL' });

  return {
    schema: 'hclabs.pre-qc-report.v1',
    mode: 'offline-no-provider-call',
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runPreQcHarness();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
