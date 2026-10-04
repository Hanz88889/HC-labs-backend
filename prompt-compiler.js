export const PROMPT_COMPILER_SCHEMA = 'hclabs.compiled-prompt.v1';

const MODULES = Object.freeze({
  subject: (s) => `SUBJECT: ${s.subject}`,
  visual: (s) => `VISUAL: ${s.visual.creative_direction}; tone=${s.visual.tone}; style=${s.visual.style}`,
  camera: (s) => `CAMERA: ${s.camera.motion}`,
  lighting: (s) => `LIGHTING: ${s.visual.lighting}`,
  motion: (s) => `MOTION: ${s.motion.subject_motion || s.motion.intensity}`,
  preservation: (s) => `PRESERVE: ${(s.preservation.preserve || []).join(', ') || 'none'}; MODIFY: ${(s.preservation.modify || []).join(', ') || 'none'}`,
  constraints: (s) => `CONSTRAINTS: ${s.constraints.join('; ') || 'none'}`,
});

export function compilePrompt(taskSpec, blueprint, { modelId = 'generic', moduleOrder = Object.keys(MODULES) } = {}) {
  if (!taskSpec?.schema || !blueprint?.schema) throw new Error('Task Spec dan Blueprint wajib tersedia');
  const lines = moduleOrder.filter((name) => MODULES[name]).map((name) => MODULES[name](taskSpec));
  if (blueprint.segments.length) {
    lines.push(`WORKFLOW: ${blueprint.workflow}; ${blueprint.segments.map((s) => `${s.id} ${s.start}-${s.end}s: ${s.objective}`).join(' | ')}`);
  }
  lines.push(`OUTPUT: mode=${taskSpec.mode}; aspect_ratio=${taskSpec.aspect_ratio}; duration_seconds=${taskSpec.duration_seconds ?? 'n/a'}`);
  return {
    schema: PROMPT_COMPILER_SCHEMA,
    compiler_version: 'v1',
    model_id: modelId,
    task_spec_schema: taskSpec.schema,
    blueprint_schema: blueprint.schema,
    prompt: lines.join('\n'),
    modules: moduleOrder.filter((name) => MODULES[name]),
  };
}
