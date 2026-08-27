// HC LABS - Cloudflare Worker Backend
// Secret env var: FAL_KEY  (dipakai HANYA oleh fal-client.js)
// Secret env var: ADMIN_SECRET (untuk /api/admin/bulk-import)
// KV binding:      LICENSE_KV
//
// ARSITEKTUR (Agustus 2026):
// - fal-client.js  → SEMUA hal spesifik provider (auth, base URL, katalog
//                    model, schema request). Ganti provider = ganti file ini saja.
// - worker.js (ini) → lisensi, kredit, ROUTING, dan TAPERING KUALITAS.
//
// TAPERING KUALITAS (baru):
// N generate pertama per siklus/per flow pakai model PREMIUM (kualitas
// terbaik), sisanya otomatis pindah ke model BUDGET yang lebih murah.
// User TIDAK melihat perbedaan apa pun — badge & history selalu menampilkan
// nama brand yang sama (mis. "Aurum Vision"), baik lagi pakai premium
// maupun budget. Threshold beda per tier (STD vs PRO) — lihat TAPER_THRESHOLD.
//
// PENTING — belum ada di file ini: proses reset kredit bulanan (di luar
// kode yang di-share ke Claude). Pastikan proses reset itu JUGA me-reset
// entry.premiumUsage = { t2i:0, i2i:0, t2v:0, i2v:0 } setiap siklus baru,
// bukan cuma entry.credits — kalau tidak, user akan permanen kejebak di
// mode budget setelah bulan pertama.
// ─────────────────────────────────────────────

import {
  ENGINES, findUrl, encodeTaskId, decodeTaskId,
  falHeaders, pollFalOnce, pollFalSync,
  submitImageGenerate, submitImageEdit, submitVideo,
} from './fal-client.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-License-Key, X-License-Email, X-Admin-Secret',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const err = (msg, status = 400) => json({ error: msg }, status);

// ─────────────────────────────────────────────
// TAPERING KUALITAS — berapa kali generate PERTAMA per flow per siklus
// yang dapat model premium, sebelum otomatis pindah ke budget.
// Ubah angka di sini kapan saja — tidak perlu ubah logika lain.
// ─────────────────────────────────────────────
const TAPER_THRESHOLD = { STD: 10, PRO: 30, STANDARD: 10 };

function taperThresholdFor(entry) {
  const tier = (entry.tier || '').toUpperCase();
  return TAPER_THRESHOLD[tier] ?? TAPER_THRESHOLD.STD;
}

// Pilih engine premium/budget untuk satu flow ('t2i'|'i2i'|'t2v'|'i2v'),
// dan naikkan counter pemakaian premium kalau masih di bawah threshold.
async function pickEngine(env, license, flowKey, enginePair) {
  const entry = license.entry;
  if (!entry.premiumUsage) entry.premiumUsage = { t2i: 0, i2i: 0, t2v: 0, i2v: 0 };
  const used = entry.premiumUsage[flowKey] ?? 0;
  const threshold = taperThresholdFor(entry);
  const usePremium = used < threshold;

  if (usePremium) {
    entry.premiumUsage[flowKey] = used + 1;
    await env.LICENSE_KV.put(license.key, JSON.stringify(entry));
  }

  return usePremium ? enginePair.premium : enginePair.budget;
}

// ─────────────────────────────────────────────
// LICENSE SYSTEM (Opsi 1.5 — Key + Email Binding) — TIDAK DIUBAH
// ─────────────────────────────────────────────
function getLicenseHeaders(request) {
  const key = request.headers.get('X-License-Key');
  const email = request.headers.get('X-License-Email');
  return { key, email };
}

async function getValidLicense(request, env) {
  const { key, email } = getLicenseHeaders(request);
  if (!key || !email) {
    return { ok: false, error: 'Key dan email wajib diisi', status: 401 };
  }

  const raw = await env.LICENSE_KV.get(key);
  if (!raw) {
    return { ok: false, error: 'Kode tidak valid', status: 404 };
  }

  const entry = JSON.parse(raw);

  if (entry.status === 'suspended') {
    return { ok: false, error: 'Akun di-suspend. Hubungi admin Cuanly.id', status: 403 };
  }

  if (entry.email && entry.email.toLowerCase() !== email.toLowerCase()) {
    return { ok: false, error: 'Kode ini terdaftar untuk email lain. Hubungi admin Cuanly.id', status: 403 };
  }

  if (!entry.email) {
    return { ok: false, error: 'Key belum diaktivasi. Silakan aktivasi lebih dulu', status: 403 };
  }

  return { ok: true, key, entry };
}

function hasCredit(entry, type) {
  return (entry.credits?.[type] ?? 0) > 0;
}

async function deductCredit(env, key, entry, type) {
  entry.credits[type] = Math.max(0, (entry.credits[type] ?? 0) - 1);
  await env.LICENSE_KV.put(key, JSON.stringify(entry));
}

// ─────────────────────────────────────────────
// POST /api/activate — TIDAK DIUBAH
// ─────────────────────────────────────────────
async function handleActivate(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { key, email } = body;
  if (!key || !email) return err('Key dan email wajib diisi');

  const raw = await env.LICENSE_KV.get(key);
  if (!raw) return err('Kode tidak valid', 404);

  const entry = JSON.parse(raw);

  if (entry.status === 'suspended') {
    return err('Akun di-suspend. Hubungi admin Cuanly.id', 403);
  }

  if (entry.email && entry.email.toLowerCase() !== email.toLowerCase()) {
    return err('Kode ini sudah terdaftar untuk email lain. Hubungi admin Cuanly.id', 403);
  }

  if (!entry.email) {
    entry.email = email.toLowerCase();
    entry.status = 'active';
    entry.bound_at = new Date().toISOString();
    await env.LICENSE_KV.put(key, JSON.stringify(entry));
  }

  return json({
    ok: true,
    tier: entry.tier,
    credits: entry.credits,
    limit: entry.limit,
    reset_date: entry.reset_date,
  });
}

// ─────────────────────────────────────────────
// GET /api/license/status — TIDAK DIUBAH
// ─────────────────────────────────────────────
async function handleLicenseStatus(request, env) {
  const check = await getValidLicense(request, env);
  if (!check.ok) return err(check.error, check.status);

  return json({
    ok: true,
    tier: check.entry.tier,
    credits: check.entry.credits,
    limit: check.entry.limit,
    reset_date: check.entry.reset_date,
  });
}

// ─────────────────────────────────────────────
// POST /api/admin/bulk-import — TIDAK DIUBAH
// ─────────────────────────────────────────────
async function handleBulkImport(request, env) {
  const adminSecret = request.headers.get('X-Admin-Secret');
  if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
    return err('Unauthorized', 401);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }
  if (!Array.isArray(body)) return err('Body harus array of {key, value}');

  let count = 0;
  for (const item of body) {
    if (!item.key || !item.value) continue;
    await env.LICENSE_KV.put(item.key, item.value);
    count++;
  }

  return json({ ok: true, imported: count });
}

// Dipakai oleh route polling yang dipanggil ulang-ulang dari frontend.
// Kredit dipotong HANYA saat status COMPLETED, dan hanya sekali per requestId.
async function resolveFalTask(taskId, license, env) {
  const decoded = decodeTaskId(taskId);
  if (!decoded) return { error: 'taskId tidak valid', status: 400 };

  const { t: creditType, m: modelId, r: requestId } = decoded;
  const r = await pollFalOnce(modelId, requestId, env).catch(e => ({ state: 'error', error: e.message }));

  if (r.state === 'error') return { result: { status: 'error', done: false, failed: true, url: null, error: r.error } };
  if (r.state === 'pending') return { result: { status: 'in_progress', done: false, failed: false, url: null } };

  const url = r.data.video?.url || r.data.images?.[0]?.url || findUrl(r.data);
  if (!url) return { result: { status: 'completed', done: false, failed: true, url: null, error: 'Tidak ada file hasil dari fal.ai' } };

  const chargeFlagKey = `charged:${requestId}`;
  const alreadyCharged = await env.LICENSE_KV.get(chargeFlagKey);
  if (!alreadyCharged) {
    await deductCredit(env, license.key, license.entry, creditType);
    await env.LICENSE_KV.put(chargeFlagKey, '1', { expirationTtl: 86400 });
  }

  return { result: { status: 'completed', done: true, failed: false, url } };
}

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
function handleHealth(env) {
  return json({
    ok: !!env.FAL_KEY,
    imageProvider: 'fal',
    videoProvider: 'fal',
    ts: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// GET /api/models — label brand saja, model asli tidak pernah diekspos
// ─────────────────────────────────────────────
async function handleModels(env) {
  return json({
    image:     [{ value: 'aurum-vision',  label: ENGINES.imageGenerate.label }],
    imageEdit: [{ value: 'aurum-retouch', label: ENGINES.imageEdit.label }],
    video:     [{ value: 'aurum-motion',  label: ENGINES.videoT2V.label }],
  });
}

// ─────────────────────────────────────────────
// POST /api/images/generate
// ─────────────────────────────────────────────
async function handleImageGenerate(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, size = '1024x1024' } = body;
  if (!prompt) return err('prompt wajib diisi');

  const modelCfg = await pickEngine(env, license, 't2i', ENGINES.imageGenerate);
  const label = ENGINES.imageGenerate.label;

  let submitData;
  try { submitData = await submitImageGenerate(modelCfg, { prompt, size }, env); }
  catch (e) { return err(e.message, 502); }

  const r = await pollFalSync(modelCfg.id, submitData.request_id, env);

  if (r.state === 'error') return err(r.error || 'Generate gagal', 502);

  if (r.state === 'done') {
    const url = r.data.images?.[0]?.url || findUrl(r.data);
    if (!url) return err('Tidak ada gambar dari provider', 502);
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url, provider: 'fal', engine: label });
  }

  const taskId = encodeTaskId('image', modelCfg.id, submitData.request_id);
  return json({ pending: true, taskId, provider: 'fal' });
}

// ─────────────────────────────────────────────
// POST /api/images/edit  (IMAGE-TO-IMAGE)
// ─────────────────────────────────────────────
async function handleImageEdit(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, image } = body;
  if (!prompt) return err('prompt wajib diisi');
  if (!image) return err('Gambar sumber wajib diupload');

  const modelCfg = await pickEngine(env, license, 'i2i', ENGINES.imageEdit);
  const label = ENGINES.imageEdit.label;

  let submitData;
  try { submitData = await submitImageEdit(modelCfg, { prompt, image }, env); }
  catch (e) { return err(e.message, 502); }

  const r = await pollFalSync(modelCfg.id, submitData.request_id, env);

  if (r.state === 'error') return err(r.error || 'Edit gagal', 502);

  if (r.state === 'done') {
    const url = r.data.images?.[0]?.url || findUrl(r.data);
    if (!url) return err('Tidak ada gambar hasil edit dari provider', 502);
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url, provider: 'fal', engine: label });
  }

  const taskId = encodeTaskId('image', modelCfg.id, submitData.request_id);
  return json({ pending: true, taskId, provider: 'fal' });
}

// ─────────────────────────────────────────────
// GET /api/images/status/:taskId
// ─────────────────────────────────────────────
async function handleImageEditPoll(request, env, parts) {
  const taskId = parts[4];
  if (!taskId) return err('taskId wajib ada di path');

  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);

  const out = await resolveFalTask(taskId, license, env);
  if (out.error) return err(out.error, out.status || 502);
  return json(out.result);
}

// ─────────────────────────────────────────────
// POST /api/videos/generate
// ─────────────────────────────────────────────
async function handleVideoGenerate(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'video')) {
    return err('Kredit video habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, ratio = '16:9', image } = body;
  if (!prompt) return err('prompt wajib diisi');

  const flowKey    = image ? 'i2v' : 't2v';
  const enginePair = image ? ENGINES.videoI2V : ENGINES.videoT2V;
  const modelCfg   = await pickEngine(env, license, flowKey, enginePair);

  let submitData;
  try { submitData = await submitVideo(modelCfg, { prompt, image, ratio }, env); }
  catch (e) { return err(e.message, 502); }

  // Video selalu async (proses 1-3 menit) — langsung balikin taskId
  const taskId = encodeTaskId('video', modelCfg.id, submitData.request_id);
  return json({ taskId, provider: 'fal' });
}

// ─────────────────────────────────────────────
// GET /api/videos/status/:provider/:taskId
// ─────────────────────────────────────────────
async function handleVideoPoll(request, env, parts) {
  const taskId = parts[5];
  if (!taskId) return err('taskId wajib ada di path');

  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);

  const out = await resolveFalTask(taskId, license, env);
  if (out.error) return err(out.error, out.status || 502);
  return json(out.result);
}

// ─────────────────────────────────────────────
// POST /api/diagnostics
// ─────────────────────────────────────────────
async function handleDiagnostics(request, env) {
  const results = [];

  results.push({
    test: 'FAL Key',
    ok: !!env.FAL_KEY,
    detail: env.FAL_KEY ? 'Key tersedia' : 'FAL_KEY belum di-set di environment variables',
  });

  try {
    const testUrl = `https://queue.fal.run/${ENGINES.imageGenerate.premium.id}/requests/00000000-0000-0000-0000-000000000000/status`;
    const res = await fetch(testUrl, { headers: falHeaders(env) });
    const authOk = res.status !== 401 && res.status !== 403;
    results.push({
      test: 'Fal.ai Connectivity',
      ok: authOk,
      detail: authOk ? `Terhubung ke fal.ai (HTTP ${res.status}, auth OK)` : 'FAL_KEY ditolak fal.ai (401/403) — cek key di Settings → Variables',
    });
  } catch (e) {
    results.push({ test: 'Fal.ai Connectivity', ok: false, detail: e.message });
  }

  try {
    if (!env.LICENSE_KV) throw new Error('KV binding tidak ditemukan');
    await env.LICENSE_KV.get('__ping__');
    results.push({ test: 'License KV', ok: true, detail: 'KV namespace terhubung' });
  } catch (e) {
    results.push({ test: 'License KV', ok: false, detail: 'LICENSE_KV belum di-bind ke Worker. Buka Settings → Variables → KV Namespace Bindings' });
  }

  results.push({
    test: 'Admin Secret',
    ok: !!env.ADMIN_SECRET,
    detail: env.ADMIN_SECRET ? 'Secret tersedia' : 'ADMIN_SECRET belum di-set di environment variables',
  });

  return json({ ok: results.every(r => r.ok), results });
}

// ─────────────────────────────────────────────
// MAIN ROUTER
// ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const path  = new URL(request.url).pathname;
    const parts = path.split('/');
    try {
      if (path === '/api/health')                                        return await handleHealth(env);
      if (path === '/api/models')                                        return await handleModels(env);
      if (path === '/api/activate'        && request.method === 'POST') return await handleActivate(request, env);
      if (path === '/api/license/status'  && request.method === 'GET')  return await handleLicenseStatus(request, env);
      if (path === '/api/admin/bulk-import' && request.method === 'POST') return await handleBulkImport(request, env);
      if (path === '/api/images/generate' && request.method === 'POST') return await handleImageGenerate(request, env);
      if (path === '/api/images/edit'     && request.method === 'POST') return await handleImageEdit(request, env);
      if (path.startsWith('/api/images/status/'))                       return await handleImageEditPoll(request, env, parts);
      if (path === '/api/videos/generate' && request.method === 'POST') return await handleVideoGenerate(request, env);
      if (path.startsWith('/api/videos/status/'))                       return await handleVideoPoll(request, env, parts);
      if (path === '/api/diagnostics'     && request.method === 'POST') return await handleDiagnostics(request, env);
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'Internal Server Error' }, 500);
    }
  },
};
