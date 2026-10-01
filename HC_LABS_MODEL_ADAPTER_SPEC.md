# HC Labs Model Adapter Spec

## Common interface
`callBrainProvider({ model, systemPrompt, input }, env)` returns `{ provider, content, model, usage }`.

## Koboi adapter
- File: `hclabsbackend/koboi-client.js`
- Protocol: OpenAI-compatible `POST {KOBOLLM_BASE_URL}/chat/completions`
- Secret: `KOBOLLM_API_KEY`; optional variables `KOBOLLM_BASE_URL` (default `https://lite.koboillm.com/v1`) and `KOBOLLM_MODEL` (default `openai/gpt-6-astra`, the full identifier shown in the KoboiLLM catalog)
- Active default: `LLM_PROVIDER=koboi`

## Z.ai adapter
- File: `hclabsbackend/zai-client.js`
- Endpoint: existing Z.ai endpoint
- Secret: `ZAI_API_KEY`; variable `ZAI_BRAIN_MODEL`
- Switch: `LLM_PROVIDER=zai`

No secret is returned in health, diagnostics, logs, or provider response. Unknown provider values safely fall back to Koboi selection. Koboi's `/v1/models` endpoint requires authentication; a GLM identifier is not assumed until the authenticated catalog confirms it.
