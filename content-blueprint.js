export const CONTENT_BLUEPRINT_SCHEMA = 'hclabs.content-blueprint.v1';

const TEMPLATES = Object.freeze({
  UGC_REVIEW_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'capture attention' },
    { id: 'experience', start: 3, end: 11, objective: 'show product experience' },
    { id: 'cta', start: 11, end: 15, objective: 'deliver clear call to action' },
  ],
  PRODUCT_DEMO_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'introduce product promise' },
    { id: 'demo', start: 3, end: 11, objective: 'demonstrate product benefit' },
    { id: 'cta', start: 11, end: 15, objective: 'close with action' },
  ],
  TESTIMONIAL_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'state relatable problem' },
    { id: 'proof', start: 3, end: 11, objective: 'deliver authentic testimonial' },
    { id: 'cta', start: 11, end: 15, objective: 'invite next step' },
  ],
  TALKING_HEAD_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'open with direct statement' },
    { id: 'message', start: 3, end: 11, objective: 'deliver concise message' },
    { id: 'cta', start: 11, end: 15, objective: 'end with conversational CTA' },
  ],
  UNBOXING_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'tease package reveal' },
    { id: 'reveal', start: 3, end: 11, objective: 'show product and reaction' },
    { id: 'cta', start: 11, end: 15, objective: 'recommend or invite action' },
  ],
  SOCIAL_AD_15S: [
    { id: 'hook', start: 0, end: 3, objective: 'stop the scroll' },
    { id: 'benefit', start: 3, end: 11, objective: 'communicate differentiated benefit' },
    { id: 'cta', start: 11, end: 15, objective: 'drive conversion action' },
  ],
});

export function buildContentBlueprint(taskSpec, workflow = null) {
  const selected = workflow || taskSpec.workflow || (taskSpec.mode.includes('video') ? 'UGC_REVIEW_15S' : 'STATIC_VISUAL');
  const template = TEMPLATES[selected] || (selected === 'STATIC_VISUAL' ? [] : null);
  if (template === null) throw new Error(`Workflow tidak didukung: ${selected}`);
  const duration = taskSpec.duration_seconds || (template.length ? 15 : null);
  const blueprint = {
    schema: CONTENT_BLUEPRINT_SCHEMA,
    blueprint_id: crypto.randomUUID(),
    workflow: selected,
    goal: taskSpec.goal,
    mode: taskSpec.mode,
    duration_seconds: duration,
    segments: template.map((segment) => ({ ...segment, duration: segment.end - segment.start })),
    validation_policy: {
      require_duration_match: Boolean(duration),
      require_subject_consistency: true,
      required_capabilities: taskSpec.model_requirements,
    },
  };
  return validateContentBlueprint(blueprint);
}

export function validateContentBlueprint(blueprint) {
  if (!blueprint || blueprint.schema !== CONTENT_BLUEPRINT_SCHEMA) throw new Error('Content Blueprint schema tidak valid');
  if (!blueprint.workflow || !Array.isArray(blueprint.segments)) throw new Error('Content Blueprint tidak lengkap');
  const total = blueprint.segments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0);
  if (blueprint.duration_seconds != null && total !== Number(blueprint.duration_seconds)) throw new Error('Durasi blueprint tidak konsisten');
  return blueprint;
}
