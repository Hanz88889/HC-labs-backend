# HC Labs Backend

Cloudflare Worker backend untuk HC Labs. Worker utama berada di `worker.js` dan memakai `hc_kv` sebagai binding license/session/spend.

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
| `wrangler.toml` | Worker name, KV binding, dan deployment metadata |

Dokumentasi Prompt Compiler berada pada file `HC_LABS_*.md` dan merupakan spesifikasi/operasional, bukan runtime code.

## Provider aktif

Production memakai Koboi melalui `LLM_PROVIDER=koboi`, `KOBOLLM_BASE_URL=https://lite.koboillm.com/v1`, dan `KOBOLLM_MODEL=openai/gpt-6-astra`. Secret API key tidak pernah disimpan di Git. Z.ai dapat diaktifkan dengan `LLM_PROVIDER=zai`.

## Test

```bash
npm test
```

## Deployment

Repository ini terhubung ke Cloudflare Workers Builds pada branch `main`. Setelah push, cek GitHub Actions dan `GET /api/health`.
