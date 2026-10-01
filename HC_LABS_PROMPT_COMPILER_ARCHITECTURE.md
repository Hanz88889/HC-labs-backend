# HC Labs Prompt Compiler — Architecture

```mermaid
flowchart LR
 U[User brief] --> B[Conversation Brain]
 B --> P[Provider Router]
 P --> K[Koboi adapter\nactive default]
 P --> Z[Z.ai adapter\nswitchable]
 K --> S[Structured content plan]
 Z --> S
 S --> F[FAL.ai media pipeline]
 F --> O[Image / Video output]
```

Provider choice is controlled by `LLM_PROVIDER` (`koboi` default, `zai` optional). Provider credentials are Worker secrets. The public route remains `POST /api/brain/refine`, so the frontend and license boundary remain unchanged.

## Rollback
Set `LLM_PROVIDER=zai` to return Brain traffic to Z.ai, or restore the previous commit. FAL.ai routes are untouched.

## Deployment
Backend: Cloudflare Worker connected to the GitHub `main` branch. Frontend: static repository deployment. This checkout cannot directly publish because Wrangler credentials are unavailable.
