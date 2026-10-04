export const TASK_SPEC_SCHEMA = 'hclabs.task-spec.v2';

const MODES = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'reference-to-video', 'video-to-video']);
const RATIOS = new Set(['1:1', '16:9', '9:16', '4:5']);

function nonEmpty(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeContentPlanV1(plan) {
  const generation = plan?.generation || {};
  const mode = generation.mode === 'image-to-image' ? 'image-to-image'
    : generation.mode === 'text-to-video' ? 'text-to-video' : 'text-to-image';
  const task = {
    schema: TASK_SPEC_SCHEMA,
    source_schema: plan?.schema || 'unknown',
    task_id: crypto.randomUUID(),
    goal: nonEmpty(plan?.goal, 'image'),
    content_type: nonEmpty(plan?.format, 'social_visual'),
    mode,
    subject: nonEmpty(plan?.subject, plan?.creative_direction || 'primary subject'),
    duration_seconds: plan?.duration_seconds == null ? null : Number(plan.duration_seconds),
    aspect_ratio: RATIOS.has(generation.aspect_ratio) ? generation.aspect_ratio : '1:1',
    references: Array.isArray(plan?.references) ? plan.references : [],
    speech: plan?.speech || { required: false, text: '' },
    visual: {
      creative_direction: nonEmpty(plan?.creative_direction),
      tone: nonEmpty(plan?.tone, 'neutral'),
      lighting: nonEmpty(plan?.lighting, 'natural'),
      style: nonEmpty(plan?.style, 'polished'),
    },
    camera: { motion: nonEmpty(generation.camera_motion, 'stable'), ...(plan?.camera || {}) },
    motion: plan?.motion || { intensity: 'controlled', subject_motion: '' },
    preservation: plan?.preservation || { preserve: [], modify: [] },
    quality: plan?.quality || { priority: 'high', output: 'production-ready' },
    constraints: Array.isArray(plan?.constraints) ? plan.constraints : [],
    workflow: plan?.workflow || null,
    model_requirements: Array.isArray(plan?.required_capabilities) ? plan.required_capabilities : [],
    scenes: Array.isArray(plan?.scenes) ? plan.scenes : [],
  };
  return validateTaskSpec(task);
}

export function validateTaskSpec(spec) {
  if (!spec || spec.schema !== TASK_SPEC_SCHEMA) throw new Error('Task Spec schema tidak valid');
  if (!MODES.has(spec.mode)) throw new Error(`Task Spec mode tidak didukung: ${spec.mode}`);
  if (!RATIOS.has(spec.aspect_ratio)) throw new Error('Task Spec aspect ratio tidak valid');
  if (!spec.goal || !spec.content_type || !spec.visual || !spec.quality) throw new Error('Task Spec field wajib tidak lengkap');
  if (!Array.isArray(spec.references) || !Array.isArray(spec.constraints) || !Array.isArray(spec.model_requirements)) {
    throw new Error('Task Spec collection field tidak valid');
  }
  if (spec.duration_seconds != null && (!Number.isFinite(spec.duration_seconds) || spec.duration_seconds <= 0)) {
    throw new Error('Task Spec duration tidak valid');
  }
  return spec;
}
