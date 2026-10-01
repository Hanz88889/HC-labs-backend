import test from 'node:test';
import assert from 'node:assert/strict';
import { callKoboiBrain } from '../koboi-client.js';
import { providerConfig, selectedProvider } from '../llm-router.js';

test('uses documented Koboi defaults when optional variables are omitted', () => {
  assert.deepEqual(providerConfig({ KOBOLLM_API_KEY: 'secret' }), {
    provider: 'koboi', model: 'openai/gpt-6-astra', ready: true, baseUrlConfigured: true,
  });
});

test('defaults to Koboi and reports readiness from its configured URL and key', () => {
  const env = { KOBOLLM_BASE_URL: 'https://koboi.example/v1', KOBOLLM_API_KEY: 'secret', KOBOLLM_MODEL: 'koboi-model' };
  assert.equal(selectedProvider(env), 'koboi');
  assert.deepEqual(providerConfig(env), { provider: 'koboi', model: 'koboi-model', ready: true, baseUrlConfigured: true });
});

test('supports switching to Z.ai without changing the route contract', () => {
  const env = { LLM_PROVIDER: 'zai', ZAI_API_KEY: 'secret' };
  assert.equal(selectedProvider(env), 'zai');
  assert.deepEqual(providerConfig(env), { provider: 'zai', model: 'glm-5.3-flash', ready: true });
});

test('falls back safely for an unknown provider value', () => {
  assert.equal(selectedProvider({ LLM_PROVIDER: 'unknown' }), 'koboi');
});

test('normalizes an OpenAI-compatible Koboi response and never exposes the API key', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      model: 'koboi-model',
      choices: [{ message: { content: '{"schema":"hclabs.content-plan.v1"}' } }],
      usage: { total_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await callKoboiBrain({ systemPrompt: 'system', input: { input: 'brief' } }, {
      KOBOLLM_BASE_URL: 'https://koboi.example/v1/',
      KOBOLLM_API_KEY: 'do-not-log-this',
      KOBOLLM_MODEL: 'koboi-model',
    });
    assert.equal(captured.url, 'https://koboi.example/v1/chat/completions');
    assert.equal(result.model, 'koboi-model');
    assert.equal(result.usage.total_tokens, 12);
    assert.equal(captured.options.headers.Authorization, 'Bearer do-not-log-this');
    assert.doesNotMatch(JSON.stringify(result), /do-not-log-this/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
