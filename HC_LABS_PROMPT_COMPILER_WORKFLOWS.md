# HC Labs Prompt Compiler — Workflows

## Conversation Brain
1. Authenticate license.
2. Read prior context from `hc_kv`.
3. Send provider-neutral system prompt and structured input to active LLM.
4. Parse JSON and validate `hclabs.content-plan.v1`.
5. Store the last eight context entries.
6. Return plan plus provider/model metadata.

## Media generation
The validated plan is sent to the existing generator by the user. FAL.ai queue submission, polling, identity/license checks, credit deduction, and spend cap remain authoritative.

## Provider rollout
Koboi is the temporary active provider. Switch to Z.ai by setting `LLM_PROVIDER=zai`; no frontend route change is required.
