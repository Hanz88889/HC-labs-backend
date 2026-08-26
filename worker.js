// HC LABS - Cloudflare Worker Backend
// Secret env var: FAL_KEY  (API key dari fal.ai — https://fal.ai/dashboard/keys)
// Secret env var: ADMIN_SECRET (untuk /api/admin/bulk-import)
// KV binding:      LICENSE_KV
//
// MIGRASI DEAPI → FAL.AI (Agustus 2026)
// Kenapa: akun DeAPI kena suspend, dan fal.ai lebih murah + lebih stabil untuk beban HC Labs.
// Model DIKUNCI (bukan dipilih bebas oleh user) demi kepastian margin — lihat ENGINES di bawah.
// Kalkulasi margin per generation (asumsi kurs ~Rp17.700/USD, Agustus 2026):
//   Image (nano-banana)         : $0.039/gambar  → ~Rp690
//   Video (ltx-2.3 fast, 6s, 1080p+audio) : $0.24/video → ~Rp4.250
// Durasi video DIKUNCI 6 detik di server — lihat FIXED_DURATION di handleVideoGenerate.
// ─────────────────────────────────────────────

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

// Base URL fal.ai queue API
const API = 'https://queue.fal.run';

// ─────────────────────────────────────────────
// ENGINE MAP — model fal.ai yang dikunci + nama brand yang tampil ke user.
// Ganti "id" di sini kalau suatu saat mau ganti model provider fal.ai;
// "label" adalah satu-satunya yang dilihat user, jadi aman diganti kapan saja.
// ─────────────────────────────────────────────
const ENGINES = {
  imageGenerate: { id: 'fal-ai/nano-banana',                  label: 'Aurum Vision' },
  imageEdit:     { id: 'fal-ai/nano-banana/edit',             label: 'Aurum Retouch' },
  videoT2V:      { id: 'fal-ai/ltx-2.3/text-to-video/fast',   label: 'Aurum Motion' },
  videoI2V:      { id: 'fal-ai/ltx-2.3/image-to-video/fast',  label: 'Aurum Motion' },
};

// ─────────────────────────────────────────────
// LICENSE SYSTEM (Opsi 1.5 — Key + Email Binding)
// TIDAK DIUBAH — sistem ini sudah provider-agnostic dari awal.
// KV Namespace binding: env.LICENSE_KV
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

// Header untuk semua request ke fal.ai (JSON only — fal terima base64 data URI
// langsung di dalam body JSON, jadi tidak perlu multipart/FormData sama sekali)
function falHeaders(env) {
  return {
    Authorization: `Key ${env.FAL_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Cari URL hasil secara rekursif — jaring pengaman kalau shape response berubah
function findUrl(obj, depth = 0) {
  if (depth > 6) return null;
  if (typeof obj === 'string' && obj.startsWith('http')) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = findUrl(item, depth + 1);
      if (f) return f;
    }
  }
  if (obj && typeof obj === 'object') {
    const priority = ['url', 'video', 'images', 'image_url', 'result_url', 'output_url'];
    for (const key of priority) {
      if (obj[key]) { const f = findUrl(obj[key], depth + 1); if (f) return f; }
    }
    for (const key of Object.keys(obj)) {
      if (!priority.includes(key)) { const f = findUrl(obj[key], depth + 1); if (f) return f; }
    }
  }
  return null;
}

// size "1024x1024" dari frontend → aspect_ratio yang dipahami nano-banana
function toImageAspectRatio(size) {
  const map = {
    '1024x1024': '1:1',
    '1792x1024': '16:9',
    '1024x1792': '9:16',
    '896x1120':  '4:5',
  };
  return map[size] || '1:1';
}

// ratio video dari frontend → aspect_ratio yang didukung LTX-2.3 (cuma landscape/portrait)
function toVideoAspectRatio(ratio) {
  return ratio === '9:16' ? '9:16' : '16:9';
}

// ─────────────────────────────────────────────
// TASK ID ENCODING
// fal.ai butuh {model, request_id} untuk polling (beda dari DeAPI yang punya
// satu endpoint /jobs/{id} universal). Supaya frontend yang sudah ada tidak
// perlu diubah (dia cuma lempar-balik taskId sebagai string buta), kita
// encode {creditType, model, request_id} jadi satu string base64url di sini,
// dan decode lagi saat polling.
// ─────────────────────────────────────────────
function encodeTaskId(creditType, modelId, requestId) {
  const raw = JSON.stringify({ t: creditType, m: modelId, r: requestId });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTaskId(taskId) {
  try {
    let b64 = taskId.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// FAL.AI QUEUE HELPERS
// Docs: https://fal.ai/docs/documentation/model-apis/inference/queue
// ─────────────────────────────────────────────
async function falSubmit(modelId, input, env) {
  const res = await fetch(`${API}/${modelId}`, {
    method: 'POST',
    headers: falHeaders(env),
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`fal.ai balas bukan JSON: HTTP ${res.status} — ${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = data.detail?.[0]?.msg || data.detail || data.error || data.message || `HTTP ${res.status} dari fal.ai`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data; // { request_id, status_url, response_url, queue_position, ... }
}

// Satu kali cek status + ambil hasil kalau sudah selesai
async function pollFalOnce(modelId, requestId, env) {
  const statusUrl   = `${API}/${modelId}/requests/${requestId}/status`;
  const responseUrl = `${API}/${modelId}/requests/${requestId}`;

  const sres = await fetch(`${statusUrl}?logs=0`, { headers: falHeaders(env) });
  const sdata = await sres.json().catch(() => ({}));
  if (!sres.ok) return { state: 'error', error: sdata.detail?.[0]?.msg || sdata.error || `HTTP ${sres.status} dari fal.ai` };
  if (sdata.error) return { state: 'error', error: sdata.error };

  const status = (sdata.status || '').toUpperCase();
  if (status !== 'COMPLETED') return { state: 'pending' };

  const rres = await fetch(responseUrl, { headers: falHeaders(env) });
  const rdata = await rres.json().catch(() => ({}));
  if (!rres.ok) return { state: 'error', error: rdata.detail?.[0]?.msg || rdata.error || 'Gagal ambil hasil dari fal.ai' };
  return { state: 'done', data: rdata };
}

// Polling sinkron di dalam handler (dipakai untuk image — biasanya selesai <10 detik)
async function pollFalSync(modelId, requestId, env, maxIter = 7) {
  for (let i = 0; i < maxIter; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await pollFalOnce(modelId, requestId, env);
    if (r.state !== 'pending') return r;
  }
  return { state: 'pending' };
}

// Dipakai oleh route polling yang dipanggil ulang-ulang dari frontend
// (/api/videos/status/:provider/:taskId dan /api/images/status/:taskId).
// Kredit dipotong HANYA saat status COMPLETED, dan hanya sekali per requestId
// (guard pakai flag "charged:requestId" di KV, sama seperti versi DeAPI dulu).
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
// GET /api/models
// Model DIKUNCI (bukan daftar dinamis dari provider) — demi margin.
// Frontend cukup menampilkan "label" sebagai nama yang dilihat user.
// ─────────────────────────────────────────────
async function handleModels(env) {
  return json({
    image:     [{ value: ENGINES.imageGenerate.id, label: ENGINES.imageGenerate.label }],
    imageEdit: [{ value: ENGINES.imageEdit.id,      label: ENGINES.imageEdit.label }],
    video:     [{ value: ENGINES.videoT2V.id,       label: ENGINES.videoT2V.label }],
  });
}

// ─────────────────────────────────────────────
// POST /api/images/generate
// fal.ai: fal-ai/nano-banana — $0.039/gambar
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
  // Catatan: field "negative" dari frontend lama sengaja tidak dipakai —
  // nano-banana tidak mendukung negative_prompt (model berbasis instruksi bahasa natural).

  const engine = ENGINES.imageGenerate;
  const input = {
    prompt,
    num_images: 1,
    aspect_ratio: toImageAspectRatio(size),
    output_format: 'png',
  };

  let submitData;
  try { submitData = await falSubmit(engine.id, input, env); }
  catch (e) { return err(e.message, 502); }

  const r = await pollFalSync(engine.id, submitData.request_id, env);

  if (r.state === 'error') return err(r.error || 'Generate gagal', 502);

  if (r.state === 'done') {
    const url = r.data.images?.[0]?.url || findUrl(r.data);
    if (!url) return err('Tidak ada gambar dari provider', 502);
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url, provider: 'fal', engine: engine.label });
  }

  // Belum selesai dalam ~21 detik → kembalikan taskId, frontend lanjut polling
  const taskId = encodeTaskId('image', engine.id, submitData.request_id);
  return json({ pending: true, taskId, provider: 'fal' });
}

// ─────────────────────────────────────────────
// POST /api/images/edit  (IMAGE-TO-IMAGE)
// fal.ai: fal-ai/nano-banana/edit — $0.039/gambar
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
  // Catatan: field "strength" dari frontend lama sengaja tidak dipakai —
  // nano-banana/edit adalah model instruksi-bahasa, tidak punya parameter strength
  // seperti model diffusion img2img konvensional.

  const engine = ENGINES.imageEdit;
  const input = {
    prompt,
    image_urls: [image], // fal terima base64 data URI langsung — tidak perlu decode ke Blob/FormData lagi
    num_images: 1,
    aspect_ratio: 'auto',
    output_format: 'png',
  };

  let submitData;
  try { submitData = await falSubmit(engine.id, input, env); }
  catch (e) { return err(e.message, 502); }

  const r = await pollFalSync(engine.id, submitData.request_id, env);

  if (r.state === 'error') return err(r.error || 'Edit gagal', 502);

  if (r.state === 'done') {
    const url = r.data.images?.[0]?.url || findUrl(r.data);
    if (!url) return err('Tidak ada gambar hasil edit dari provider', 502);
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url, provider: 'fal', engine: engine.label });
  }

  const taskId = encodeTaskId('image', engine.id, submitData.request_id);
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
// fal.ai: fal-ai/ltx-2.3/text-to-video/fast atau /image-to-video/fast
// $0.04/detik @1080p — durasi DIKUNCI 6 detik = $0.24/video, flat.
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

  // Durasi & resolusi DIKUNCI di server demi kepastian margin — nilai "duration"
  // dari frontend sengaja diabaikan. Kalau nanti mau expose pilihan durasi ke
  // user, ingat: itu bikin cost per generation bervariasi (tidak flat lagi),
  // jadi kredit juga harus disesuaikan proporsional, bukan tetap 1 kredit/video.
  const FIXED_DURATION = 6;
  const engine = image ? ENGINES.videoI2V : ENGINES.videoT2V;

  const input = {
    prompt,
    duration: FIXED_DURATION,
    resolution: '1080p',
    aspect_ratio: toVideoAspectRatio(ratio),
    generate_audio: true,
    ...(image ? { image_url: image } : {}),
  };

  let submitData;
  try { submitData = await falSubmit(engine.id, input, env); }
  catch (e) { return err(e.message, 502); }

  // Video selalu async (proses 1-3 menit) — langsung balikin taskId,
  // frontend yang polling lewat /api/videos/status/:provider/:taskId
  const taskId = encodeTaskId('video', engine.id, submitData.request_id);
  return json({ taskId, provider: 'fal' });
}

// ─────────────────────────────────────────────
// GET /api/videos/status/:provider/:taskId
// (":provider" di path diabaikan — cuma sisa dari desain lama, taskId sudah
// membawa semua info yang dibutuhkan untuk polling ke fal.ai)
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

  // Test 1: FAL_KEY tersedia
  results.push({
    test: 'FAL Key',
    ok: !!env.FAL_KEY,
    detail: env.FAL_KEY ? 'Key tersedia' : 'FAL_KEY belum di-set di environment variables',
  });

  // Test 2: Konektivitas + auth ke fal.ai (cek murah — bukan generate beneran).
  // Pakai request_id palsu: 404 = server fal.ai kebaca & key valid (normal).
  // 401/403 = FAL_KEY ditolak.
  try {
    const testUrl = `${API}/${ENGINES.imageGenerate.id}/requests/00000000-0000-0000-0000-000000000000/status`;
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

  // Test 3: LICENSE_KV terhubung
  try {
    if (!env.LICENSE_KV) throw new Error('KV binding tidak ditemukan');
    await env.LICENSE_KV.get('__ping__');
    results.push({ test: 'License KV', ok: true, detail: 'KV namespace terhubung' });
  } catch (e) {
    results.push({ test: 'License KV', ok: false, detail: 'LICENSE_KV belum di-bind ke Worker. Buka Settings → Variables → KV Namespace Bindings' });
  }

  // Test 4: ADMIN_SECRET tersedia
  results.push({
    test: 'Admin Secret',
    ok: !!env.ADMIN_SECRET,
    detail: env.ADMIN_SECRET ? 'Secret tersedia' : 'ADMIN_SECRET belum di-set di environment variables',
  });

  return json({ ok: results.every(r => r.ok), results });
}

// ─────────────────────────────────────────────
// MAIN ROUTER — path sama persis seperti sebelumnya, tidak ada yang berubah
// di sisi frontend/kontrak API.
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
