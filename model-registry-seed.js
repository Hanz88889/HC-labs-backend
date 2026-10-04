import { ENGINES } from './fal-client.js';

const DEFINITIONS = [
  ['imageGenerate', 't2i', ['text-to-image'], 0.039, 0.025],
  ['imageEdit', 'i2i', ['image-to-image', 'image_reference'], 0.039, 0.035],
  ['videoT2V', 't2v', ['text-to-video'], 0.20, 0.20],
  ['videoI2V', 'i2v', ['image-to-video', 'image_reference'], 0.20, 0.20],
];

export function buildModelRegistrySeed() {
  return DEFINITIONS.flatMap(([engineKey, flow, capabilities, premiumCost, budgetCost]) => {
    const engine = ENGINES[engineKey];
    return ['premium', 'budget'].map((tier) => {
      const cfg = engine[tier];
      const modelKey = `${flow}-${tier}`;
      return {
        model: { modelKey, provider: 'fal', modelId: cfg.id, label: engine.label, active: true },
        capabilities: capabilities.map((name) => ({ modelKey, name, supported: true })),
        pricing: { modelKey, pricingKey: 'request', unit: 'request', amountUsd: tier === 'premium' ? premiumCost : budgetCost },
      };
    });
  });
}
