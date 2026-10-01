# HC Labs Prompt Compiler — Repository Audit

**Tanggal:** 2026-10-01  
**Scope:** `hclabsbackend` dan `hclabsfrontend`

## 1. Arsitektur saat ini
- Frontend adalah satu `index.html` statis dengan Tailwind CDN, state lokal, dan fetch ke Cloudflare Worker.
- Backend adalah Cloudflare Worker (`worker.js`) dengan KV `hc_kv`.
- Media generation memakai adapter `fal-client.js` dan queue/polling fal.ai.
- Conversation Brain memakai `brain-router.js` + provider LLM.

## 2. Batas frontend/backend
Frontend tidak menyimpan secret. License key/email dikirim sebagai header `X-License-Key` dan `X-License-Email`. Backend mengautentikasi dan mengakses provider/KV.

## 3. Entry point AI
- `POST /api/images/generate`
- `POST /api/images/edit`
- `POST /api/videos/generate`
- `POST /api/brain/refine`

## 4. Prompt construction dan model selection
Media prompt dikirim ke fal.ai melalui `fal-client.js`. Conversation Brain menyusun structured content plan melalui `brain-router.js`. Sebelum perubahan ini provider Brain hanya Z.ai; provider aktif kini dipilih `LLM_PROVIDER` dan default-nya Koboi.

## 5. Provider integration
- fal.ai: `FAL_KEY`, adapter terisolasi.
- Z.ai: `zai-client.js`, `ZAI_API_KEY`, `ZAI_BRAIN_MODEL`.
- Koboi: `koboi-client.js`, `KOBOLLM_BASE_URL`, `KOBOLLM_API_KEY`, `KOBOLLM_MODEL`.

## 6. Reference image, callback, storage
Reference image dikirim sebagai data URL ke fal.ai. Queue status dipoll dari Worker; tidak ada webhook di source ini. Hasil provider berupa URL eksternal. **UNKNOWN / NEEDS VERIFICATION:** lifecycle storage/retensi URL provider di luar Worker.

## 7. Credit/billing
KV license menyimpan `credits`; kredit media dikurangi ketika hasil selesai. Brain menggunakan daily spend cap, tetapi tidak mengurangi kredit media. Tidak dibuat sistem kredit kedua.

## 8. Database/logging/retry
KV adalah persistence utama. Retry polling berada di `pollFalSync`; retry generation otomatis belum ada. **UNKNOWN / NEEDS VERIFICATION:** reporting biaya bisnis di luar repository.

## 9. Komponen stabil yang dilindungi
Lisensi, KV key format, FAL queue contract, task ID encoding, polling, dan frontend generator dipertahankan.

## 10. Rekomendasi insertion point
Provider-independent insertion point adalah `brain-router.js -> llm-router.js -> {koboi-client,zai-client}`. `/api/brain/refine` tetap backward-compatible. Switch provider cukup mengubah `LLM_PROVIDER` tanpa menyentuh pipeline FAL.ai.

## 11. Deployment constraint
Repository backend memiliki `wrangler.toml`, tetapi sandbox ini tidak memiliki `wrangler` atau kredensial Cloudflare. Push ke `main` adalah mekanisme deployment yang didokumentasikan oleh repository (Workers & Pages connected Git). Deployment final perlu diverifikasi dari workflow/dashboard provider setelah push.
