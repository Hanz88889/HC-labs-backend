# HC Labs Backend

Cloudflare Worker backend untuk HC Labs. Worker utama berada di `worker.js`. D1 `HC_DB` menjadi source of truth untuk license dan lifecycle generation; KV `hc_kv` dipertahankan untuk session Brain, spend guard, lock, serta fallback migrasi license.

## Struktur aktif

| File | Fungsi |
|---|---|
| `worker.js` | Routing API, license, credit, spend cap, locking, polling, diagnostics |
| `fal-client.js` | Adapter FAL.ai untuk image/video generation |
| `brain-router.js` | Validasi dan persistence content plan Conversation Brain |
| `llm-router.js` | Pemilihan provider Koboi/Z.ai |
| `koboi-client.js` | Adapter KoboiLLM OpenAI-compatible |
| `zai-client.js` | Adapter Z.ai |
| `test/` | Regression/unit tests |
| `d1-store.js` | Adapter D1 untuk license, jobs, attempts, events, validation, quota, dan settlement |
| `job-lifecycle.js` | State machine job/quota, timeout, dan retry policy |
| `migrations/` | Migration D1 yang sudah diterapkan ke database production |
| `wrangler.toml` | Worker name, KV/D1 binding, dan deployment metadata |

Dokumentasi Prompt Compiler berada pada file `HC_LABS_*.md` dan merupakan spesifikasi/operasional, bukan runtime code.

## Quorvante Ads Agent (MVP read-only)

Fondasi Ads Agent tersedia di `ads-agent.js`. Endpoint `GET /api/ads-agent/status` menunjukkan readiness Cloudflare, sedangkan `POST /api/ads-agent/analyze` menghitung CAC/ROAS/CTR/CPC dan rekomendasi dari insight terstruktur tanpa mengubah Meta Ads. Schema D1 tambahan ada di `migrations/0007_ads_agent.sql`; detail kontrak dan roadmap ada di `QUORVANTE_ADS_AGENT_MVP.md`.

Fase ini sengaja **tidak** memiliki Meta OAuth, budget mutation, pause/resume, atau auto-spend. Semua action berisiko tetap menunggu fase approval execution.

## Provider aktif

Production memakai Koboi melalui `LLM_PROVIDER=koboi`, `KOBOLLM_BASE_URL=https://lite.koboillm.com/v1`, dan `KOBOLLM_MODEL=openai/gpt-6-astra`. Secret API key tidak pernah disimpan di Git. Z.ai dapat diaktifkan dengan `LLM_PROVIDER=zai`.

## Test

```bash
npm test
```

## Deployment

Repository ini terhubung ke Cloudflare Workers Builds pada branch `main`. Setelah push, verifikasi build marker dan `GET /api/health` pada Worker production.
