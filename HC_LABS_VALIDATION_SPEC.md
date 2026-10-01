# HC Labs Validation Spec

## Brain
- Reject malformed JSON from the provider.
- Validate schema, goal/mode, aspect ratio, scene count, and video duration.
- Return HTTP 502 for provider/network/invalid-output errors.
- Keep provider name/model/usage metadata; never include API keys.

## Media
Existing validation boundary remains FAL queue status, output URL existence, and one-time credit charge. Polling has a bounded loop; no infinite generation retry is introduced.

## Operational checks
`GET /api/health` exposes `brainProvider`, `brainModel`, `brainModelConfigured`, and non-secret readiness summaries for both providers.
