# Provider Security Notes

- Provider keys are Worker secrets only.
- `GET /api/health` reports booleans/configuration metadata, never URLs containing credentials or keys.
- Provider errors are normalized to messages without request headers.
- Existing license authentication remains required for Brain.
- `KOBOLLM_BASE_URL` must be configured by an operator and is not inferred from unverified public sources.
