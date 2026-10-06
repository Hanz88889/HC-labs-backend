# Quorvante Ads Agent — MVP slice

Blueprint sumber: `QUORVANTE_ADS_AGENT_BLUEPRINT.md`.

## Keputusan fase pertama

MVP ini dimulai pada **READ ONLY**. Worker menghitung CAC, ROAS, CTR, CPC, dan budget utilization dari payload insight terstruktur; rule engine menghasilkan rekomendasi, tetapi tidak mengubah campaign, budget, atau status Meta.

> `LLM` menjelaskan hasil terstruktur. Ia bukan sumber angka transaksi dan tidak boleh melewati rule engine.

## Cloudflare mapping

- **Workers**: API/orchestrator dan scheduled monitoring.
- **D1 (`HC_DB`)**: koneksi Meta, snapshots insight, business rules, proposals, approval state, dan audit log.
- **R2 (`HC_ASSETS`)**: creative assets dan report exports.
- **KV (`LICENSE_KV`)**: tetap dipakai untuk compatibility layer lisensi yang sudah ada.

Migration `0007_ads_agent.sql` menyiapkan tabel baru; migration belum diterapkan ke production pada branch ini.

## Kontrak analisis

`POST /api/ads-agent/analyze` menerima:

```json
{
  "command": "Analisa performa 7 hari terakhir",
  "campaigns": [
    {"id":"cmp_1","name":"Campaign A","status":"ACTIVE","spend":90000,"purchases":3,"revenue":399000,"impressions":10000,"clicks":250}
  ],
  "rules": {"targetCac":40000}
}
```

Respons memakai schema `quorvante.ads-analysis.v1` dan selalu menandai `safety.executionAllowed=false`.

## Urutan implementasi berikutnya

1. Meta OAuth + token encryption/rotation melalui secret management.
2. Meta insights adapter dengan rate-limit, retry, pagination, dan idempotency.
3. Sinkronisasi snapshot berkala ke D1.
4. Dashboard read-only untuk campaign dan analytics.
5. LLM adapter untuk ringkasan/rekomendasi dari hasil backend.
6. Proposal + approval endpoint.
7. Baru setelah data dan permission tervalidasi: pause/resume/budget update dengan approval.

## Guardrail

- Data angka berasal dari Meta/API atau database, bukan LLM.
- Bila token, permission, data, atau rule tidak lengkap: **ACTION BLOCKED**.
- Tidak ada auto-spend pada MVP.
- Setiap action masa depan wajib tercatat di `ads_audit_logs`.
