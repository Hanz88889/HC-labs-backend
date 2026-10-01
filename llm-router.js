import { callKoboiBrain, koboiConfig } from './koboi-client.js';
import { callZaiBrain, DEFAULT_BRAIN_MODEL } from './zai-client.js';

export const LLM_PROVIDERS = Object.freeze(['koboi', 'zai']);
export const DEFAULT_LLM_PROVIDER = 'koboi';

export function selectedProvider(env) {
  const value = String(env.LLM_PROVIDER || DEFAULT_LLM_PROVIDER).trim().toLowerCase();
  return LLM_PROVIDERS.includes(value) ? value : DEFAULT_LLM_PROVIDER;
}

export function providerConfig(env, provider = selectedProvider(env)) {
  if (provider === 'zai') {
    return { provider, model: env.ZAI_BRAIN_MODEL || DEFAULT_BRAIN_MODEL, ready: !!env.ZAI_API_KEY };
  }
  const config = koboiConfig(env);
  return { provider, model: config.model, ready: !!(config.apiKey && config.baseUrl), baseUrlConfigured: !!config.baseUrl };
}

export async function callBrainProvider(args, env) {
  const provider = selectedProvider(env);
  if (provider === 'zai') return { provider, ...(await callZaiBrain(args, env)) };
  const config = providerConfig(env, provider);
  return { provider, ...(await callKoboiBrain({ ...args, model: args.model || config.model }, env)) };
}
