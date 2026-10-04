import { ENGINES } from './fal-client.js';

export const TAPER_THRESHOLDS = Object.freeze({ STD: 10, PRO: 30, STANDARD: 10 });

const FLOW_ENGINES = Object.freeze({
  t2i: 'imageGenerate',
  i2i: 'imageEdit',
  t2v: 'videoT2V',
  i2v: 'videoI2V',
});

function thresholdFor(entry = {}) {
  return TAPER_THRESHOLDS[String(entry.tier || '').toUpperCase()] ?? TAPER_THRESHOLDS.STD;
}

export function selectModelForFlow({ license, flow, enginePair = null } = {}) {
  const entry = license?.entry || {};
  const engineKey = FLOW_ENGINES[flow];
  const registry = enginePair || ENGINES[engineKey];
  if (!registry) throw new Error(`Unknown generation flow: ${flow}`);
  const used = Number(entry.premiumUsage?.[flow] || 0);
  const threshold = thresholdFor(entry);
  const usePremium = used < threshold;
  const modelCfg = registry[usePremium ? 'premium' : 'budget'];
  return {
    modelCfg,
    usePremium,
    flow,
    engineKey: engineKey || null,
    premiumUsed: used,
    premiumThreshold: threshold,
  };
}

export function modelRoutingMatrix() {
  return Object.entries(FLOW_ENGINES).map(([flow, engine]) => ({
    flow,
    engine,
    premium: ENGINES[engine].premium.id,
    budget: ENGINES[engine].budget.id,
  }));
}
