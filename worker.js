// HC LABS - Cloudflare Worker Backend
// Secret env var: DEAPI_KEY

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

// Base URL DeAPI v2
const API = 'https://api.deapi.ai/api/v2';

// ─────────────────────────────────────────────
// LICENSE SYSTEM (Opsi 1.5 — Key + Email Binding)
// KV Namespace binding: env.LICENSE_KV
// ─────────────────────────────────────────────

// Ambil key + email dari header request
function getLicenseHeaders(request) {
  const key = request.headers.get('X-License-Key');
  const email = request.headers.get('X-License-Email');
  return { key, email };
}

// Validasi key+email, return { ok, entry, error, status }
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

// Cek kredit cukup untuk tipe tertentu ('image' | 'video')
function hasCredit(entry, type) {
  return (entry.credits?.[type] ?? 0) > 0;
}

// Kurangi kredit & simpan balik ke KV
async function deductCredit(env, key, entry, type) {
  entry.credits[type] = Math.max(0, (entry.credits[type] ?? 0) - 1);
  await env.LICENSE_KV.put(key, JSON.stringify(entry));
}

// ─────────────────────────────────────────────
// POST /api/activate
// Body: { key, email }
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
// GET /api/license/status
// Header: X-License-Key, X-License-Email
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
// POST /api/admin/bulk-import
// Header: X-Admin-Secret (harus cocok env.ADMIN_SECRET)
// Body: [{ key, value }, ...]
// SEMENTARA — hapus endpoint ini setelah selesai import sekali jalan
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

// Header JSON untuk image generate & polling (bukan untuk multipart)
function jsonHeaders(env) {
  return {
    Authorization: `Bearer ${env.DEAPI_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// Header tanpa Content-Type — untuk multipart/form-data (img2video)
function authHeaders(env) {
  return {
    Authorization: `Bearer ${env.DEAPI_KEY}`,
    'Accept': 'application/json',
  };
}

// Mapping aspect ratio → width/height untuk video
// Ltxv_13B batas max: width & height <= 768, kelipatan 32
function ratioToSize(ratio) {
  const map = {
    '16:9': { width: 768, height: 432 },
    '9:16': { width: 432, height: 768 },
    '1:1':  { width: 512, height: 512 },
    '4:5':  { width: 512, height: 640 },
    '4:3':  { width: 576, height: 432 },
  };
  return map[ratio] || { width: 768, height: 432 };
}

// Cari URL hasil secara rekursif di dalam response object
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
    const priority = ['result_url','output_url','url','image_url','file_url','src','output','image','result','preview'];
    for (const key of priority) {
      if (obj[key]) { const f = findUrl(obj[key], depth + 1); if (f) return f; }
    }
    for (const key of Object.keys(obj)) {
      if (!priority.includes(key)) { const f = findUrl(obj[key], depth + 1); if (f) return f; }
    }
  }
  return null;
}

function extractSlugs(data) {
  return (data.data || data.models || [])
    .map(m => typeof m === 'string' ? m : (m.slug || m.id || m.name || ''))
    .filter(Boolean);
}

// ─────────────────────────────────────────────
// POLLING — GET /api/v2/jobs/{requestId}
// Docs: https://docs.deapi.ai/api/v2/utilities/jobs.md
// Status enum: pending | processing | done | error
// ─────────────────────────────────────────────
async function pollResult(requestId, env, maxIter = 8) {
  for (let i = 0; i < maxIter; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${API}/jobs/${requestId}`, {
        headers: jsonHeaders(env),
      });
      if (!res.ok) continue;
      const d = await res.json();
      // Response: { data: { status, result_url, preview, progress } }
      const status = (d.data?.status || d.status || '').toLowerCase();
      if (status === 'done') {
        const url = d.data?.result_url || findUrl(d);
        return { done: true, url };
      }
      if (status === 'error') {
        return { done: false, failed: true, error: d.data?.error || d.message || 'error' };
      }
    } catch (_) {}
  }
  return { done: false, failed: false };
}

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
function handleHealth(env) {
  return json({
    ok: !!env.DEAPI_KEY,
    imageProvider: 'deapi',
    videoProvider: 'deapi',
    ts: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// GET /api/models
// ─────────────────────────────────────────────
async function handleModels(env) {
  let imageModels = [];
  let videoModels = [];

  try {
    const res = await fetch(`${API}/models?filter[inference_types]=image/generations`, {
      headers: jsonHeaders(env),
    });
    if (res.ok) imageModels = extractSlugs(await res.json());
  } catch (_) {}

  try {
    const res = await fetch(`${API}/models?filter[inference_types]=video/generations`, {
      headers: jsonHeaders(env),
    });
    if (res.ok) videoModels = extractSlugs(await res.json());
  } catch (_) {}

  if (!imageModels.length) imageModels = ['Flux_2_Klein_4B_BF16', 'ZImageTurbo_INT8', 'Flux1schnell'];
  if (!videoModels.length) videoModels = ['Ltxv_13B_0_9_8_Distilled_FP8'];

  return json({ image: imageModels, video: videoModels });
}

// ─────────────────────────────────────────────
// POST /api/images/generate
// DeAPI: POST /api/v2/images/generations
// Docs: https://docs.deapi.ai/api/v2/images/generations.md
// Required: prompt, model, width, height, guidance, steps, seed
// ─────────────────────────────────────────────
async function handleImageGenerate(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, model, size = '1024x1024', negative = '' } = body;
  if (!prompt) return err('prompt wajib diisi');

  // Konversi size string → width/height integer (kelipatan 128, max 1536)
  const rawW = parseInt((size || '1024x1024').split('x')[0]) || 1024;
  const rawH = parseInt((size || '1024x1024').split('x')[1]) || 1024;
  const width  = Math.min(Math.round(rawW / 128) * 128 || 1024, 1536);
  const height = Math.min(Math.round(rawH / 128) * 128 || 1024, 1536);
  const selectedModel = (model && model !== 'default') ? model : 'Flux_2_Klein_4B_BF16';

  const res = await fetch(`${API}/images/generations`, {
    method: 'POST',
    headers: jsonHeaders(env),
    body: JSON.stringify({
      model: selectedModel,
      prompt,
      width,
      height,
      guidance: 7.5,
      steps: 4,
      seed: Math.floor(Math.random() * 9999999),
      ...(negative ? { negative_prompt: negative } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      const e = JSON.parse(text);
      return err(e.message || e.error?.message || `HTTP ${res.status}`, res.status);
    } catch {
      return err(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
  }

  const data = await res.json();
  // Response: { data: { request_id } }
  const requestId = data.data?.request_id ?? data.request_id ?? data.id;

  // Kalau tidak ada requestId → response langsung (sync)
  if (!requestId) {
    const url = findUrl(data);
    if (url) {
      await deductCredit(env, license.key, license.entry, 'image');
      return json({ type: 'url', url, provider: 'deapi' });
    }
    return err('Tidak ada gambar dari provider');
  }

  // Async: poll max 8x (24 detik) di worker
  const result = await pollResult(requestId, env);

  if (result.failed) return err(result.error || 'Generate gagal');
  if (result.done && result.url) {
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url: result.url, provider: 'deapi' });
  }

  // Belum selesai dalam 24 detik → kembalikan taskId ke frontend
  return json({ pending: true, taskId: requestId, provider: 'deapi' });
}

// ─────────────────────────────────────────────
// POST /api/images/edit  (IMAGE-TO-IMAGE)
// DeAPI: endpoint pasti belum terkonfirmasi 100% dari dokumentasi publik.
// Dicoba berurutan: /images/edits lalu fallback /images/img2img.
// Body: { prompt, model, image (base64 data URL), strength, negative }
// Model default: Flux_2_Klein_4B_BF16 (style transfer / kreatif)
// Alternatif: Qwen_Image_Edit_Plus (instruksi teks presisi)
// ─────────────────────────────────────────────
async function handleImageEdit(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, model, image, strength = 0.65, negative = '' } = body;
  if (!prompt) return err('prompt wajib diisi');
  if (!image) return err('Gambar sumber wajib diupload');

  const selectedModel = (model && model !== 'default') ? model : 'Flux_2_Klein_4B_BF16';

  // Batas steps per model (sesuai constraint DeAPI, beda-beda per model)
  // Model yang tidak ada di map ini tidak dikirimi field steps sama sekali,
  // biar DeAPI pakai default internal mereka
  const EDIT_MODEL_CONSTRAINTS = {
    'Flux_2_Klein_4B_BF16': { steps: 4 },
  };

  const base64 = image.replace(/^data:image\/\w+;base64,/, '');
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'image/png' });

  const buildForm = () => {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('model', selectedModel);
    form.append('strength', String(strength));
    form.append('guidance', '7.5');

    const editConstraint = EDIT_MODEL_CONSTRAINTS[selectedModel];
    if (editConstraint && editConstraint.steps) {
      form.append('steps', String(editConstraint.steps));
    }

    form.append('seed', String(Math.floor(Math.random() * 9999999)));
    if (negative) form.append('negative_prompt', negative);
    form.append('image', blob, 'source.png');
    return form;
  };

  const candidates = [`${API}/images/edits`, `${API}/images/img2img`];
  let res = null;
  let notFoundDetail = '';

  for (const url of candidates) {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(env),
      body: buildForm(),
    });
    if (res.status !== 404) break;
    notFoundDetail = await res.text().catch(() => '');
  }

  if (!res.ok) {
    if (res.status === 404) {
      return err(`Endpoint image-to-image tidak ditemukan di DeAPI (dicoba: ${candidates.join(', ')}). Detail: ${notFoundDetail.slice(0, 200)}`, 404);
    }
    const text = await res.text().catch(() => '');
    try {
      const e = JSON.parse(text);
      let msg = e.message || e.error?.message || `HTTP ${res.status}`;
      if (e.errors && typeof e.errors === 'object') {
        const details = Object.entries(e.errors)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`)
          .join(' | ');
        if (details) msg += ` — Detail: ${details}`;
      }
      return err(msg, res.status);
    } catch {
      return err(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
  }

  const data = await res.json();
  const requestId = data.data?.request_id ?? data.request_id ?? data.id;

  if (!requestId) {
    const url = findUrl(data);
    if (url) {
      await deductCredit(env, license.key, license.entry, 'image');
      return json({ type: 'url', url, provider: 'deapi' });
    }
    return err('Tidak ada gambar hasil edit dari provider');
  }

  const result = await pollResult(requestId, env);

  if (result.failed) return err(result.error || 'Edit gagal');
  if (result.done && result.url) {
    await deductCredit(env, license.key, license.entry, 'image');
    return json({ type: 'url', url: result.url, provider: 'deapi' });
  }

  return json({ pending: true, taskId: requestId, provider: 'deapi' });
}

// ─────────────────────────────────────────────
// GET /api/images/status/:taskId
// Polling terpisah untuk image edit (kredit 'image', bukan 'video')
// ─────────────────────────────────────────────
async function handleImageEditPoll(request, env, parts) {
  const taskId = parts[4];
  if (!taskId) return err('taskId wajib ada di path');

  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);

  const res = await fetch(`${API}/jobs/${taskId}`, {
    headers: jsonHeaders(env),
  });

  if (!res.ok) {
    const text = await res.text();
    return err(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  const data = await res.json();
  const status = (data.data?.status || data.status || 'unknown').toLowerCase();
  const url = data.data?.result_url || findUrl(data);
  const done   = status === 'done';
  const failed = status === 'error';

  if (done) {
    const chargeFlagKey = `charged-img:${taskId}`;
    const alreadyCharged = await env.LICENSE_KV.get(chargeFlagKey);
    if (!alreadyCharged) {
      await deductCredit(env, license.key, license.entry, 'image');
      await env.LICENSE_KV.put(chargeFlagKey, '1', { expirationTtl: 86400 });
    }
  }

  return json({ status, done, failed, url: url || null });
}

// ─────────────────────────────────────────────
// POST /api/videos/generate
//
// Dua mode:
// 1. Text-to-Video   → POST /api/v2/videos/generations  (JSON)
//    Required: prompt, model, width, height, guidance, steps, seed, frames
//
// 2. Image-to-Video  → POST /api/v2/videos/animations   (multipart/form-data)
//    Required: prompt, first_frame_image (binary), model, width, height,
//              guidance, steps, seed, frames
//
// Docs: https://docs.deapi.ai/api/v2/videos/generations.md
//       https://docs.deapi.ai/api/v2/videos/animations.md
// ─────────────────────────────────────────────
async function handleVideoGenerate(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'video')) {
    return err('Kredit video habis bulan ini. Hubungi admin Cuanly.id untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, model, duration = 5, ratio = '16:9', image } = body;
  if (!prompt) return err('prompt wajib diisi');

  const selectedModel = (model && model !== 'default') ? model : 'Ltxv_13B_0_9_8_Distilled_FP8';
  const { width, height } = ratioToSize(ratio);

  // ── Batas per model (sesuai constraint DeAPI) ──
  const MODEL_CONSTRAINTS = {
    'Ltxv_13B_0_9_8_Distilled_FP8': { fps: 30, maxFrames: 120, steps: 1, maxWidth: 768, maxHeight: 768 },
    'Ltxv_13B_0_9_7_FP8':           { fps: 25, maxFrames: 120, steps: 30, maxWidth: 768, maxHeight: 768 },
    'Wan_T2V_14B_FP8':              { fps: 16, maxFrames: 120, steps: 30, maxWidth: 1280, maxHeight: 720 },
    'Wan_I2V_14B_480P_FP8':         { fps: 16, maxFrames: 81,  steps: 30, maxWidth: 832,  maxHeight: 480 },
  };
  const c = MODEL_CONSTRAINTS[selectedModel] || { fps: 24, maxFrames: 120, steps: 1 };

  const fps    = c.fps;
  const frames = Math.min(Math.max(9, duration * fps), c.maxFrames);

  // Clamp width/height sesuai model jika ada batas
  const safeWidth  = c.maxWidth  ? Math.min(width,  c.maxWidth)  : width;
  const safeHeight = c.maxHeight ? Math.min(height, c.maxHeight) : height;

  const seed = Math.floor(Math.random() * 9999999);

  let res;

  if (image) {
    // ── Mode 2: Image-to-Video (multipart/form-data) ──
    // first_frame_image harus dikirim sebagai binary, bukan base64 string
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    const form = new FormData();
    form.append('prompt', prompt);
    form.append('model', selectedModel);
    form.append('width', String(safeWidth));
    form.append('height', String(safeHeight));
    form.append('guidance', '7.5');
    form.append('steps', String(c.steps));
    form.append('frames', String(frames));
    form.append('fps', String(fps));
    form.append('seed', String(seed));
    form.append('first_frame_image', blob, 'frame.jpg');

    res = await fetch(`${API}/videos/animations`, {
      method: 'POST',
      headers: authHeaders(env), // Tanpa Content-Type — biar FormData isi sendiri
      body: form,
    });

  } else {
    // ── Mode 1: Text-to-Video (JSON) ──
    res = await fetch(`${API}/videos/generations`, {
      method: 'POST',
      headers: jsonHeaders(env),
      body: JSON.stringify({
        model: selectedModel,
        prompt,
        width:    safeWidth,
        height:   safeHeight,
        guidance: 7.5,
        steps:    c.steps,
        frames,
        fps,
        seed,
      }),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    try {
      const e = JSON.parse(text);
      return err(e.message || e.error?.message || `HTTP ${res.status}`, res.status);
    } catch {
      return err(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
  }

  const data = await res.json();
  // Response: { data: { request_id } }
  const taskId = data.data?.request_id ?? data.request_id ?? data.id;
  if (!taskId) return err('Tidak ada task_id dari provider');

  return json({ taskId, provider: 'deapi' });
}

// ─────────────────────────────────────────────
// GET /api/videos/status/:provider/:taskId
// DeAPI: GET /api/v2/jobs/{requestId}
// Status enum: pending | processing | done | error
// ─────────────────────────────────────────────
async function handleVideoPoll(request, env, parts) {
  const taskId = parts[5];
  if (!taskId) return err('taskId wajib ada di path');

  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);

  const res = await fetch(`${API}/jobs/${taskId}`, {
    headers: jsonHeaders(env),
  });

  if (!res.ok) {
    const text = await res.text();
    return err(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  const data = await res.json();
  // Response: { data: { status, result_url, preview, progress } }
  const status = (data.data?.status || data.status || 'unknown').toLowerCase();
  const url = data.data?.result_url || findUrl(data);
  const done   = status === 'done';
  const failed = status === 'error';

  // Potong kredit HANYA saat video benar-benar selesai, dan hanya 1x
  // per taskId (guard pakai flag "charged:taskId" di KV agar polling
  // berulang tidak memotong kredit lebih dari sekali).
  if (done) {
    const chargeFlagKey = `charged:${taskId}`;
    const alreadyCharged = await env.LICENSE_KV.get(chargeFlagKey);
    if (!alreadyCharged) {
      await deductCredit(env, license.key, license.entry, 'video');
      // Flag disimpan 24 jam — cukup untuk mencegah double-deduct dari polling,
      // sekaligus otomatis hilang sendiri tanpa perlu dibersihkan manual.
      await env.LICENSE_KV.put(chargeFlagKey, '1', { expirationTtl: 86400 });
    }
  }

  return json({ status, done, failed, url: url || null });
}

// ─────────────────────────────────────────────
// POST /api/diagnostics
// ─────────────────────────────────────────────
async function handleDiagnostics(request, env) {
  const results = [];

  // Test 1: DEAPI_KEY tersedia
  results.push({
    test: 'DEAPI Key',
    ok: !!env.DEAPI_KEY,
    detail: env.DEAPI_KEY ? 'Key tersedia' : 'DEAPI_KEY belum di-set di environment variables',
  });

  // Test 2: Image Provider
  try {
    const res = await fetch(`${API}/models?filter[inference_types]=image/generations`, {
      headers: jsonHeaders(env),
    });
    const data = res.ok ? await res.json() : {};
    results.push({ test: 'Image Provider (deapi)', ok: res.ok, detail: `${(data.data||[]).length} models` });
  } catch (e) {
    results.push({ test: 'Image Provider', ok: false, detail: e.message });
  }

  // Test 3: Video Provider
  try {
    const res = await fetch(`${API}/models?filter[inference_types]=video/generations`, {
      headers: jsonHeaders(env),
    });
    const data = res.ok ? await res.json() : {};
    results.push({ test: 'Video Provider (deapi)', ok: res.ok, detail: `${(data.data||[]).length} models` });
  } catch (e) {
    results.push({ test: 'Video Provider', ok: false, detail: e.message });
  }

  // Test 4: LICENSE_KV terhubung
  try {
    if (!env.LICENSE_KV) throw new Error('KV binding tidak ditemukan');
    await env.LICENSE_KV.get('__ping__');
    results.push({ test: 'License KV', ok: true, detail: 'KV namespace terhubung' });
  } catch (e) {
    results.push({ test: 'License KV', ok: false, detail: 'LICENSE_KV belum di-bind ke Worker. Buka Settings → Variables → KV Namespace Bindings' });
  }

  // Test 5: ADMIN_SECRET tersedia
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
