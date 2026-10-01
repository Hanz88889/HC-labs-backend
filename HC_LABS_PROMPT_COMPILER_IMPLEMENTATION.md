# HC Labs Prompt Compiler — Implementation

## Delivered
- `koboi-client.js`: OpenAI-compatible Koboi adapter with timeout and bounded payloads.
- `llm-router.js`: provider selection and readiness.
- `brain-router.js`: provider-neutral orchestration while preserving route and KV context.
- `worker.js`: health metadata and spend model use active provider.
- frontend: active provider labels.
- unit tests and audit/spec documents.

## Required Worker configuration
Set secrets/variables in Cloudflare Worker settings:

```text
LLM_PROVIDER=koboi
KOBOLLM_BASE_URL=https://lite.koboillm.com/v1
KOBOLLM_API_KEY=<secret>
KOBOLLM_MODEL=openai/gpt-6-astra
ZAI_API_KEY=<secret kept ready for switch>
ZAI_BRAIN_MODEL=glm-5.3-flash
```

Do not commit the API key. The base URL and model above are documented Koboi catalog values; both remain overrideable. GPT-6 Astra is priced materially higher than the previous default, so the backend spend guard estimates up to `$0.20` per Brain call before the daily cap.

## Rollout
1. Configure Koboi and keep Z.ai key available.
2. Publish backend from `main`.
3. Verify health and one authenticated Brain request.
4. Switch to Z.ai by changing `LLM_PROVIDER=zai` if needed.
5. Roll back by setting `LLM_PROVIDER=zai` or reverting the commit.
