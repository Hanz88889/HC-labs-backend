import { ENGINES } from './fal-client.js';

export const CAPABILITY_REGISTRY = Object.freeze({
  'text-to-image': {
    flow: 't2i', engine: 'imageGenerate', required: [], reference: 'none',
  },
  'image-to-image': {
    flow: 'i2i', engine: 'imageEdit', required: ['image_reference'], reference: 'single-image',
  },
  'text-to-video': {
    flow: 't2v', engine: 'videoT2V', required: [], reference: 'none',
  },
  'image-to-video': {
    flow: 'i2v', engine: 'videoI2V', required: ['image_reference'], reference: 'single-image',
  },
  'reference-to-video': {
    flow: 'i2v', engine: 'videoI2V', required: ['image_reference', 'multi_reference_compositing'], reference: 'contact-sheet',
  },
  'video-to-video': {
    flow: null, engine: null, required: ['video_reference'], reference: 'video', unsupported: true,
  },
});

function hasRequiredCapabilities(taskSpec, route) {
  const requested = new Set(taskSpec.model_requirements || []);
  const references = Array.isArray(taskSpec.references) ? taskSpec.references : [];
  return route.required.every((capability) => (
    requested.has(capability)
    || capability === 'image_reference'
    || (capability === 'multi_reference_compositing' && references.length > 1)
  ));
}

export function routeTaskSpec(taskSpec, { tier = 'premium' } = {}) {
  const route = CAPABILITY_REGISTRY[taskSpec?.mode];
  if (!route) throw new Error(`Unsupported generation mode: ${taskSpec?.mode || 'missing'}`);
  if (route.unsupported) return { supported: false, reason: 'UNSUPPORTED_CAPABILITY', mode: taskSpec.mode };
  if (!hasRequiredCapabilities(taskSpec, route)) {
    return { supported: false, reason: 'MISSING_CAPABILITY', mode: taskSpec.mode, required: route.required };
  }
  const engine = ENGINES[route.engine];
  const selected = engine?.[tier] || engine?.premium;
  if (!selected) return { supported: false, reason: 'MODEL_NOT_REGISTERED', mode: taskSpec.mode };
  return {
    supported: true,
    mode: taskSpec.mode,
    flow: route.flow,
    engine: route.engine,
    model: selected.id,
    tier: tier === 'budget' ? 'budget' : 'premium',
    reference_strategy: route.reference,
    required_capabilities: route.required,
  };
}

export function listCapabilities() {
  return Object.entries(CAPABILITY_REGISTRY).map(([mode, route]) => ({
    mode,
    supported: !route.unsupported,
    flow: route.flow,
    reference_strategy: route.reference,
    required_capabilities: route.required,
  }));
}
