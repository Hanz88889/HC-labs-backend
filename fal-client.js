// ═════════════════════════════════════════════════════════════
// FAL-CLIENT.JS — satu-satunya file yang tahu soal provider fal.ai.
//
// KENAPA FILE INI DIPISAH:
// Kalau suatu saat mau ganti endpoint/provider (fal.ai → provider lain,
// atau ganti model di dalam fal.ai), yang perlu diubah CUKUP file ini.
// worker.js (logika lisensi, kredit, tapering kualitas) tidak perlu
// disentuh sama sekali selama fungsi-fungsi di bawah ini tetap punya
// signature yang sama.
//
// Secret yang dipakai file ini: env.FAL_KEY (satu-satunya tempat FAL_KEY
// dibaca di seluruh codebase — lihat falHeaders()).
// ═════════════════════════════════════════════════════════════

export const API = 'https://queue.fal.run';

// ─────────────────────────────────────────────
// KATALOG ENGINE — setiap flow (generate/edit/video) punya versi
// PREMIUM dan BUDGET. "label" adalah satu-satunya yang dilihat user
// (di badge UI & history) — sama persis baik lagi pakai premium atau
// budget, jadi user tidak pernah tahu ada pergantian di baliknya.
//
// Sumber harga: riset fal.ai official pages, cross-check dengan
// Credit_Pricing_Model.xlsx (Agustus 2026). Harga API berubah —
// verifikasi ulang tiap 2-4 minggu.
// ─────────────────────────────────────────────
export const ENGINES = {
  imageGenerate: {
    label: 'Aurum Vision',
    premium: { id: 'fal-ai/nano-banana',  sizing: 'aspect' },   // $0.039/gambar
    budget:  { id: 'fal-ai/flux/schnell', sizing: 'flux'   },   // $0.025/gambar
  },
  imageEdit: {
    label: 'Aurum Retouch',
    premium: { id: 'fal-ai/nano-banana/edit', imageField: 'image_urls' }, // $0.039/gambar
    budget:  { id: 'fal-ai/qwen-image-2/edit', imageField: 'image_url'  }, // $0.035/gambar
  },
  videoT2V: {
    label: 'Aurum Motion',
    premium: { id: 'fal-ai/ltx-2.3/text-to-video/fast', family: 'ltx' }, // $0.04/detik @1080p, 6s = $0.24
    budget:  { id: 'fal-ai/wan-t2v',                      family: 'wan' }, // $0.20/video flat @480p
  },
  videoI2V: {
    label: 'Aurum Motion',
    premium: { id: 'fal-ai/ltx-2.3/image-to-video/fast', family: 'ltx' },
    budget:  { id: 'fal-ai/wan-i2v',                      family: 'wan' },
  },
};

// Header untuk semua request ke fal.ai — SATU-SATUNYA tempat FAL_KEY dipakai.
export function falHeaders(env) {
  return {
    Authorization: `Key ${env.FAL_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Cari URL hasil secara rekursif — jaring pengaman kalau shape response berubah
export function findUrl(obj, depth = 0) {
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

function toImageAspectRatio(size) {
  const map = { '1024x1024': '1:1', '1792x1024': '16:9', '1024x1792': '9:16', '896x1120': '4:5' };
  return map[size] || '1:1';
}

function toVideoAspectRatio(ratio) {
  return ratio === '9:16' ? '9:16' : '16:9';
}

// ─────────────────────────────────────────────
// TASK ID ENCODING — fal.ai butuh {model, request_id} untuk polling.
// Di-encode jadi satu string base64url supaya frontend (yang cuma
// lempar-balik taskId sebagai string buta) tidak perlu diubah.
// ─────────────────────────────────────────────
export function encodeTaskId(creditType, modelId, requestId) {
  const raw = JSON.stringify({ t: creditType, m: modelId, r: requestId });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTaskId(taskId) {
  try {
    let b64 = taskId.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// INPUT BUILDERS — tiap model punya schema request beda-beda.
// Ini satu-satunya tempat yang perlu diubah kalau ganti model.
// ─────────────────────────────────────────────
function buildImageGenerateInput(modelCfg, { prompt, size }) {
  if (modelCfg.sizing === 'flux') {
    const [w, h] = (size || '1024x1024').split('x').map(Number);
    return { prompt, image_size: { width: w || 1024, height: h || 1024 }, num_images: 1 };
  }
  return { prompt, num_images: 1, aspect_ratio: toImageAspectRatio(size), output_format: 'png' };
}

function buildImageEditInput(modelCfg, { prompt, image }) {
  if (modelCfg.imageField === 'image_url') {
    return { prompt, image_url: image };
  }
  return { prompt, image_urls: [image], num_images: 1, aspect_ratio: 'auto', output_format: 'png' };
}

function buildVideoInput(modelCfg, { prompt, image, ratio }) {
  const aspect_ratio = toVideoAspectRatio(ratio);
  if (modelCfg.family === 'wan') {
    const base = { prompt, resolution: '480p', aspect_ratio, num_frames: 81, frames_per_second: 16 };
    return image ? { ...base, image_url: image } : base;
  }
  // family: 'ltx' — durasi dikunci 6 detik demi kepastian margin (lihat catatan di worker.js)
  const base = { prompt, duration: 6, resolution: '1080p', aspect_ratio, generate_audio: true };
  return image ? { ...base, image_url: image } : base;
}

// ─────────────────────────────────────────────
// FAL.AI QUEUE HELPERS
// Docs: https://fal.ai/docs/documentation/model-apis/inference/queue
// ─────────────────────────────────────────────
export async function falSubmit(modelId, input, env) {
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

export async function pollFalOnce(modelId, requestId, env) {
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

export async function pollFalSync(modelId, requestId, env, maxIter = 7) {
  for (let i = 0; i < maxIter; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await pollFalOnce(modelId, requestId, env);
    if (r.state !== 'pending') return r;
  }
  return { state: 'pending' };
}

// ─────────────────────────────────────────────
// HIGH-LEVEL SUBMIT — dipanggil dari worker.js, sudah termasuk pemilihan
// schema input yang benar untuk modelCfg yang diberikan.
// ─────────────────────────────────────────────
export function submitImageGenerate(modelCfg, args, env) {
  return falSubmit(modelCfg.id, buildImageGenerateInput(modelCfg, args), env);
}
export function submitImageEdit(modelCfg, args, env) {
  return falSubmit(modelCfg.id, buildImageEditInput(modelCfg, args), env);
}
export function submitVideo(modelCfg, args, env) {
  return falSubmit(modelCfg.id, buildVideoInput(modelCfg, args), env);
}
