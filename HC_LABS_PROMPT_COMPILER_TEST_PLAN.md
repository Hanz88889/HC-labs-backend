# HC Labs Prompt Compiler — Test Plan

Automated coverage:
- provider default selection (Koboi)
- Z.ai switch selection
- unknown-provider safe fallback
- Koboi OpenAI-compatible URL/body/response normalization
- secret non-disclosure in normalized output
- existing plan validation for image/edit/video
- mismatched mode and invalid duration rejection

Regression checks:
- `node --check` for all Worker modules
- `npm test`
- inspect unchanged FAL routes and license/credit functions

Deployment checks:
- GitHub Actions backend test workflow
- after connected Worker publish, anonymous `/api/health` response should show configured media/KV and selected Brain provider; authenticated Brain request should return schema `hclabs.content-plan.v1`.
