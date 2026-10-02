// HC LABS - Cloudflare Worker Backend
// Secret env var: FAL_KEY  (dipakai HANYA oleh fal-client.js)
// Secret env var: ADMIN_SECRET (untuk /api/admin/bulk-import)
// KV binding:      hc_kv
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
import { handleBrainRefine } from './brain-router.js';
import { DEFAULT_BRAIN_MODEL } from './zai-client.js';
import { providerConfig, selectedProvider } from './llm-router.js';
import { elapsedSeconds, shouldExpireGeneration } from './job-lifecycle.js';
import {
  getD1License, upsertD1License, migrateKvLicense, d1Status,
  createGenerationJob, updateGenerationJob, recordQuotaLedger,
  getGenerationJob, reserveGenerationAtomic, settleGenerationAtomic,
  recordGenerationEvent, updateGenerationAttempt,
} from './d1-store.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-License-Key, X-License-Email, X-Admin-Secret, Idempotency-Key',
};

const BUILD_VERSION = 'phase-4-timeout-retry-policy-2026-10-03';

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
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

function taperThresholdFor(entry) {
  const tier = (entry.tier || '').toUpperCase();
  return TAPER_THRESHOLD[tier] ?? TAPER_THRESHOLD.STD;
}

// Tentukan engine premium/budget untuk satu flow ('t2i'|'i2i'|'t2v'|'i2v')
// TANPA menulis apa pun — supaya bisa dicek dulu (kredit, circuit breaker)
// sebelum kuota premium beneran "dipakai". Ini sengaja dipisah dari
// commitPremiumUsage (lihat di bawah) — kalau digabung, giliran circuit
// breaker nolak permintaan, counter premium tetap naik padahal generate-nya
// gak pernah kejadian. Itu bug yang sempat ada di versi sebelumnya.
function decideEngine(license, flowKey, enginePair) {
  const entry = license.entry;
  const used = entry.premiumUsage?.[flowKey] ?? 0;
  const threshold = taperThresholdFor(entry);
  const usePremium = used < threshold;
  return { modelCfg: usePremium ? enginePair.premium : enginePair.budget, usePremium };
}

// Baru nulis counter premiumUsage ke KV di sini — dipanggil HANYA setelah
// semua pengecekan lain (kredit, circuit breaker) lolos.
async function commitPremiumUsage(env, license, flowKey) {
  const entry = license.entry;
  if (!entry.premiumUsage) entry.premiumUsage = { t2i: 0, i2i: 0, t2v: 0, i2v: 0 };
  entry.premiumUsage[flowKey] = (entry.premiumUsage[flowKey] ?? 0) + 1;
  await env.hc_kv.put(license.key, JSON.stringify(entry));
  await upsertD1License(env, license.key, entry);
}

// ─────────────────────────────────────────────
// CIRCUIT BREAKER — pengaman biaya, independen dari harga model spesifik.
// Estimasi biaya tiap call diakumulasi ke KV per hari; kalau tembus batas,
// generate baru ditolak otomatis sampai hari berikutnya. Ini jaring
// pengaman kalau suatu saat ada model yang ternyata lebih mahal dari
// perkiraan (persis kasus LTX-2.3 kemarin — realnya lebih mahal & durasi
// image-to-video gak sesuai permintaan) — gak perlu nunggu ketahuan dari
// tagihan lagi. Estimasi konservatif, dibulatkan ke atas, jadi cap
// kebentur sedikit lebih awal daripada telat.
// ─────────────────────────────────────────────
const DAILY_SPEND_CAP_USD = 5; // ganti sesuai toleransi risiko harian lo

const ESTIMATED_COST_USD = {
  'fal-ai/nano-banana': 0.04,
  'fal-ai/nano-banana/edit': 0.04,
  'fal-ai/flux/schnell': 0.03,
  'fal-ai/qwen-image-2/edit': 0.04,
  'fal-ai/wan-t2v': 0.20,
  'fal-ai/wan-i2v': 0.20,
  'glm-5.3-flash': 0.03,
  'openai/gpt-6-astra': 0.20,
  'gpt-6-astra': 0.20,
};

async function checkAndRecordSpend(env, modelId) {
  const cost = ESTIMATED_COST_USD[modelId] ?? 0.25; // model gak dikenal = asumsi mahal, aman
  const dayKey = `spend:${new Date().toISOString().slice(0, 10)}`;
  const raw = await env.hc_kv.get(dayKey);
  const current = raw ? parseFloat(raw) : 0;
  if (current + cost > DAILY_SPEND_CAP_USD) {
    return { allowed: false };
  }
  await env.hc_kv.put(dayKey, String(current + cost), { expirationTtl: 172800 });
  return { allowed: true };
}

// ─────────────────────────────────────────────
// IDEMPOTENCY LOCK — cegah 1 user submit 2 generate bersamaan di flow yang
// sama (double-tap tombol, retry otomatis dari frontend karena lag, dsb).
// Tanpa ini, tiap tap ganda = biaya fal.ai dobel percuma. TTL jadi jaring
// pengaman kalau proses gagal ditengah jalan tanpa sempat release lock.
// ─────────────────────────────────────────────
async function acquireLock(env, lockKey, ttlSeconds) {
  const existing = await env.hc_kv.get(lockKey);
  if (existing) return false;
  const safeTtl = Math.max(KV_MIN_EXPIRATION_TTL_SECONDS, Number(ttlSeconds) || KV_MIN_EXPIRATION_TTL_SECONDS);
  await env.hc_kv.put(lockKey, '1', { expirationTtl: safeTtl });
  return true;
}

async function releaseLock(env, lockKey) {
  await env.hc_kv.delete(lockKey);
}


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

  const d1License = await getD1License(env, key);
  const raw = d1License ? null : await env.hc_kv.get(key);
  if (!raw && !d1License) {
    return { ok: false, error: 'Kode tidak valid', status: 404 };
  }

  const entry = d1License?.entry || JSON.parse(raw);
  if (!d1License && raw) await migrateKvLicense(env, key, raw);

  if (entry.status === 'suspended') {
    return { ok: false, error: 'Akun di-suspend. Hubungi admin HC Labs', status: 403 };
  }

  if (entry.email && entry.email.toLowerCase() !== email.toLowerCase()) {
    return { ok: false, error: 'Kode ini terdaftar untuk email lain. Hubungi admin HC Labs', status: 403 };
  }

  if (!entry.email) {
    return { ok: false, error: 'Key belum diaktivasi. Silakan aktivasi lebih dulu', status: 403 };
  }

  return { ok: true, key, entry, source: d1License ? 'd1' : 'kv' };
}

function hasCredit(entry, type) {
  return (entry.credits?.[type] ?? 0) > 0;
}

async function deductCredit(env, key, entry, type) {
  entry.credits[type] = Math.max(0, (entry.credits[type] ?? 0) - 1);
  await env.hc_kv.put(key, JSON.stringify(entry));
  await upsertD1License(env, key, entry);
}

// ─────────────────────────────────────────────
// POST /api/activate — TIDAK DIUBAH
// ─────────────────────────────────────────────
async function handleActivate(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { key, email } = body;
  if (!key || !email) return err('Key dan email wajib diisi');

  const d1License = await getD1License(env, key);
  const raw = d1License ? null : await env.hc_kv.get(key);
  if (!raw && !d1License) return err('Kode tidak valid', 404);

  const entry = d1License?.entry || JSON.parse(raw);

  if (entry.status === 'suspended') {
    return err('Akun di-suspend. Hubungi admin HC Labs', 403);
  }

  if (entry.email && entry.email.toLowerCase() !== email.toLowerCase()) {
    return err('Kode ini sudah terdaftar untuk email lain. Hubungi admin HC Labs', 403);
  }

  if (!entry.email) {
    entry.email = email.toLowerCase();
    entry.status = 'active';
    entry.bound_at = new Date().toISOString();
    await env.hc_kv.put(key, JSON.stringify(entry));
  }
  await upsertD1License(env, key, entry);

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
  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }
  const bodySecret = !Array.isArray(body) ? String(body?.adminSecret || '').trim() : '';
  const headerSecret = request.headers.get('X-Admin-Secret')?.trim();
  const authorization = request.headers.get('Authorization') || '';
  const bearerSecret = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const configuredSecret = String(env.ADMIN_SECRET || '').trim();
  if (!configuredSecret || (![headerSecret, bearerSecret, bodySecret].includes(configuredSecret))) {
    return err('Unauthorized', 401);
  }

  const entries = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(entries)) return err('Body harus array of {key, value} atau object dengan items');

  let count = 0;
  for (const item of entries) {
    if (!item.key || !item.value) continue;
    await env.hc_kv.put(item.key, item.value);
    count++;
  }

  return json({ ok: true, imported: count });
}

async function handleD1Migration(request, env) {
  const headerSecret = request.headers.get('X-Admin-Secret')?.trim();
  const authorization = request.headers.get('Authorization') || '';
  const bearerSecret = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const configuredSecret = String(env.ADMIN_SECRET || '').trim();
  if (!configuredSecret || (![headerSecret, bearerSecret].includes(configuredSecret))) {
    return err('Unauthorized', 401);
  }
  if (!env.HC_DB) return err('D1 belum di-bind ke Worker', 503);

  let cursor;
  let scanned = 0;
  let migrated = 0;
  do {
    const page = await env.hc_kv.list({ cursor, limit: 1000 });
    for (const item of page.keys || []) {
      scanned++;
      const raw = await env.hc_kv.get(item.name);
      if (await migrateKvLicense(env, item.name, raw)) migrated++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ ok: true, scanned, migrated, d1: d1Status(env) });
}

// Dipakai oleh route polling yang dipanggil ulang-ulang dari frontend.
// Kredit dipotong HANYA saat status COMPLETED, dan hanya sekali per requestId.
async function resolveFalTask(taskId, license, env) {
  const decoded = decodeTaskId(taskId);
  if (!decoded) return { error: 'taskId tidak valid', status: 400 };

  const { t: creditType, m: modelId, r: requestId, j: jobId, a: attemptId } = decoded;
  const job = jobId ? await getGenerationJob(env, jobId).catch(() => null) : null;
  const elapsed = elapsedSeconds(job?.created_at);
  const r = await pollFalOnce(modelId, requestId, env).catch(() => ({ state: 'error', error: 'Layanan media gagal memproses permintaan' }));

  if (r.state === 'error') {
    const settled = jobId ? await settleGenerationAtomic(env, {
      licenseKey: license.key,
      jobId,
      attemptId,
      creditType,
      settlement: 'RELEASE',
      errorCode: 'MEDIA_ERROR',
      errorMessage: r.error,
      metadata: { request_id: requestId },
    }).catch(() => ({ ok: false })) : { ok: false };
    if (!settled.ok) {
      await updateGenerationJob(env, jobId, { status: 'FAILED', errorCode: 'MEDIA_ERROR', errorMessage: r.error });
    }
    return { result: { status: 'error', stage: 'failed', elapsed_seconds: elapsed, done: false, failed: true, url: null, error: r.error } };
  }
  if (r.state === 'pending') {
    if (job?.created_at && shouldExpireGeneration(job.created_at)) {
      const expired = await settleGenerationAtomic(env, {
        licenseKey: license.key,
        jobId,
        attemptId,
        creditType,
        settlement: 'RELEASE',
        terminalStatus: 'EXPIRED',
        attemptStatus: 'EXPIRED',
        errorCode: 'TIMEOUT',
        errorMessage: 'Generation melebihi batas waktu pemrosesan',
        metadata: { request_id: requestId, elapsed_seconds: elapsed },
      }).catch(() => ({ ok: false }));
      if (!expired.ok) {
        await updateGenerationJob(env, jobId, {
          status: 'EXPIRED', errorCode: 'TIMEOUT',
          errorMessage: 'Generation melebihi batas waktu pemrosesan',
        });
        await updateGenerationAttempt(env, attemptId, {
          status: 'EXPIRED', errorCode: 'TIMEOUT',
          errorMessage: 'Generation melebihi batas waktu pemrosesan',
          completedAt: new Date().toISOString(),
        });
      }
      return { result: {
        status: 'expired', stage: 'timeout', elapsed_seconds: elapsed,
        done: false, failed: true, url: null, error: 'Generation timeout',
      } };
    }
    await updateGenerationJob(env, jobId, { status: 'PROCESSING' });
    await updateGenerationAttempt(env, attemptId, { status: 'PROCESSING' });
    if (jobId) {
      await recordGenerationEvent(env, {
        eventId: `processing:${jobId}`,
        jobId,
        eventType: 'PROCESSING',
        fromStatus: 'SUBMITTED',
        toStatus: 'PROCESSING',
        metadata: { request_id: requestId },
      });
    }
    return { result: { status: 'in_progress', stage: 'processing', elapsed_seconds: elapsed, done: false, failed: false, url: null } };
  }

  const url = r.data.video?.url || r.data.images?.[0]?.url || findUrl(r.data);
  if (!url) {
    const settled = jobId ? await settleGenerationAtomic(env, {
      licenseKey: license.key,
      jobId,
      attemptId,
      creditType,
      settlement: 'RELEASE',
      errorCode: 'NO_RESULT',
      errorMessage: 'Tidak ada file hasil',
      metadata: { request_id: requestId },
    }).catch(() => ({ ok: false })) : { ok: false };
    if (!settled.ok) {
      await updateGenerationJob(env, jobId, { status: 'FAILED', errorCode: 'NO_RESULT', errorMessage: 'Tidak ada file hasil' });
    }
    return { result: { status: 'failed', stage: 'failed', elapsed_seconds: elapsed, done: false, failed: true, url: null, error: 'Tidak ada file hasil dari layanan media' } };
  }

  const committed = jobId ? await settleGenerationAtomic(env, {
    licenseKey: license.key,
    jobId,
    attemptId,
    creditType,
    settlement: 'COMMIT',
    resultUrl: url,
    metadata: { request_id: requestId, result_url: url },
  }).catch(() => ({ ok: false })) : { ok: false };
  if (committed.ok) {
    return { result: { status: 'completed', stage: 'completed', elapsed_seconds: elapsed, done: true, failed: false, url } };
  }

  const chargeFlagKey = `charged:${requestId}`;
  const chargeLockKey = `charge-lock:${requestId}`;
  const alreadyCharged = await env.hc_kv.get(chargeFlagKey);
  if (!alreadyCharged && await acquireLock(env, chargeLockKey, KV_MIN_EXPIRATION_TTL_SECONDS)) {
    try {
      const currentRaw = await env.hc_kv.get(license.key);
      const currentEntry = currentRaw ? JSON.parse(currentRaw) : null;
      if (currentEntry && !(await env.hc_kv.get(chargeFlagKey))) {
        await deductCredit(env, license.key, currentEntry, creditType);
        await env.hc_kv.put(chargeFlagKey, '1', { expirationTtl: 86400 });
        await recordQuotaLedger(env, {
          licenseKey: license.key,
          jobId,
          eventType: 'COMPLETED',
          creditType,
          units: -1,
          idempotencyKey: `charge:${requestId}`,
          metadata: { request_id: requestId },
        });
      }
    } finally {
      await releaseLock(env, chargeLockKey);
    }
  }

  await updateGenerationJob(env, jobId, { status: 'COMPLETED', resultUrl: url, completedAt: new Date().toISOString() });

  return { result: { status: 'completed', done: true, failed: false, url } };
}

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
function handleHealth(env) {
  const mediaReady = !!env.FAL_KEY;
  const llmProvider = selectedProvider(env);
  const llm = providerConfig(env, llmProvider);
  const brainReady = llm.ready;
  const kvReady = !!env.hc_kv;
  const d1 = d1Status(env);
  return json({
    ok: mediaReady && brainReady && kvReady,
    build: BUILD_VERSION,
    runtime: 'hclabs',
    apiVersion: 'v2',
    mediaReady,
    brainReady,
    kvReady,
    d1Ready: d1.configured,
    d1Binding: d1.binding,
    imageProvider: 'media-engine',
    videoProvider: 'media-engine',
    brainProvider: 'llm-router',
    brainModel: 'configured-model',
    brainModelConfigured: llm.ready,
    llmProviders: { configured: llm.ready },
    generationPipeline: ['HC Labs Generator', 'Media Engine', 'IMAGE / VIDEO'],
    ts: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// POST /api/brain/refine — provider-independent Conversation Brain
// ─────────────────────────────────────────────
async function handleBrainRefineRoute(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);

  const lockKey = `inflight:${license.key}:brain`;
  if (!(await acquireLock(env, lockKey, 60))) {
    return err('Permintaan sebelumnya masih diproses, tunggu beberapa detik.', 429);
  }

  try {
    const brainModel = providerConfig(env, selectedProvider(env)).model || DEFAULT_BRAIN_MODEL;
    const spend = await checkAndRecordSpend(env, brainModel);
    if (!spend.allowed) return err('Batas biaya API harian tercapai. Coba lagi besok atau hubungi admin.', 503);

    const result = await handleBrainRefine(request, env, license);
    if (result.error) return err(result.error, result.status || 400);
    return json(result);
  } catch (e) {
    return err('Conversation Brain gagal memproses permintaan.', 502);
  } finally {
    await releaseLock(env, lockKey);
  }
}

// ─────────────────────────────────────────────
// GET /api/models — label brand saja, model asli tidak pernah diekspos
// ─────────────────────────────────────────────
async function handleModels(env) {
  return json({
    image:     [{ value: 'aurum-vision',  label: 'HC Labs Image Engine' }],
    imageEdit: [{ value: 'aurum-retouch', label: 'HC Labs Edit Engine' }],
    video:     [{ value: 'aurum-motion',  label: 'HC Labs Motion Engine' }],
  });
}

// ─────────────────────────────────────────────
// POST /api/images/generate
// ─────────────────────────────────────────────
async function handleImageGenerate(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin HC Labs untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, size = '1024x1024' } = body;
  if (!prompt) return err('prompt wajib diisi');
  if (typeof prompt !== 'string' || prompt.length > 8000) return err('prompt terlalu panjang (maksimal 8.000 karakter)', 413);

  const lockKey = `inflight:${license.key}:t2i`;
  if (!(await acquireLock(env, lockKey, 60))) {
    return err('Permintaan sebelumnya masih diproses, tunggu beberapa detik.', 429);
  }

  try {
    const { modelCfg, usePremium } = decideEngine(license, 't2i', ENGINES.imageGenerate);
    const label = ENGINES.imageGenerate.label;

    const spend = await checkAndRecordSpend(env, modelCfg.id);
    if (!spend.allowed) return err('Batas biaya API harian tercapai. Coba lagi besok atau hubungi admin.', 503);
    if (usePremium) await commitPremiumUsage(env, license, 't2i');

    let submitData;
    try { submitData = await submitImageGenerate(modelCfg, { prompt, size }, env); }
    catch { return err('Layanan media gagal menerima permintaan gambar', 502); }

    const r = await pollFalSync(modelCfg.id, submitData.request_id, env);

    if (r.state === 'error') return err('Layanan media gagal menghasilkan gambar', 502);

    if (r.state === 'done') {
      const url = r.data.images?.[0]?.url || findUrl(r.data);
      if (!url) return err('Tidak ada gambar dari layanan media', 502);
      await deductCredit(env, license.key, license.entry, 'image');
      return json({ type: 'url', url, provider: 'fal', engine: label });
    }

    const taskId = encodeTaskId('image', modelCfg.id, submitData.request_id);
    return json({ pending: true, taskId, provider: 'fal' });
  } finally {
    await releaseLock(env, lockKey);
  }
}

// ─────────────────────────────────────────────
// POST /api/images/edit  (IMAGE-TO-IMAGE)
// ─────────────────────────────────────────────
async function handleImageEdit(request, env) {
  const license = await getValidLicense(request, env);
  if (!license.ok) return err(license.error, license.status);
  if (!hasCredit(license.entry, 'image')) {
    return err('Kredit image habis bulan ini. Hubungi admin HC Labs untuk upgrade', 402);
  }

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const { prompt, image } = body;
  if (!prompt) return err('prompt wajib diisi');
  if (typeof prompt !== 'string' || prompt.length > 8000) return err('prompt terlalu panjang (maksimal 8.000 karakter)', 413);
  if (!image) return err('Gambar sumber wajib diupload');

  const lockKey = `inflight:${license.key}:i2i`;
  if (!(await acquireLock(env, lockKey, 60))) {
    return err('Permintaan sebelumnya masih diproses, tunggu beberapa detik.', 429);
  }

  try {
    const { modelCfg, usePremium } = decideEngine(license, 'i2i', ENGINES.imageEdit);
    const label = ENGINES.imageEdit.label;

    const spend = await checkAndRecordSpend(env, modelCfg.id);
    if (!spend.allowed) return err('Batas biaya API harian tercapai. Coba lagi besok atau hubungi admin.', 503);
    if (usePremium) await commitPremiumUsage(env, license, 'i2i');

    let submitData;
    try { submitData = await submitImageEdit(modelCfg, { prompt, image }, env); }
    catch { return err('Layanan media gagal menerima permintaan edit', 502); }

    const r = await pollFalSync(modelCfg.id, submitData.request_id, env);

    if (r.state === 'error') return err('Layanan media gagal mengedit gambar', 502);

    if (r.state === 'done') {
      const url = r.data.images?.[0]?.url || findUrl(r.data);
      if (!url) return err('Tidak ada gambar hasil edit dari layanan media', 502);
      await deductCredit(env, license.key, license.entry, 'image');
      return json({ type: 'url', url, provider: 'fal', engine: label });
    }

    const taskId = encodeTaskId('image', modelCfg.id, submitData.request_id);
    return json({ pending: true, taskId, provider: 'fal' });
  } finally {
    await releaseLock(env, lockKey);
  }
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

  let body;
  try { body = await request.json(); } catch { return err('Body JSON tidak valid'); }

  const {
    prompt, ratio = '16:9', image, duration_seconds: requestedDuration, duration = 5,
    reference_count = image ? 1 : 0, reference_strategy = image ? 'single-image' : null,
  } = body;
  if (!prompt) return err('prompt wajib diisi');
  if (typeof prompt !== 'string' || prompt.length > 8000) return err('prompt terlalu panjang (maksimal 8.000 karakter)', 413);
  const durationSeconds = Number(requestedDuration ?? duration);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 15) {
    return err('duration_seconds harus berupa bilangan bulat antara 2 dan 15');
  }
  const idempotencyKey = request.headers.get('Idempotency-Key') || crypto.randomUUID();

  const flowKey = image ? 'i2v' : 't2v';
  const lockKey = `inflight:${license.key}:${flowKey}`;
  if (!(await acquireLock(env, lockKey, 60))) {
    return err('Permintaan sebelumnya masih diproses, tunggu beberapa detik.', 429);
  }

  try {
    const enginePair = image ? ENGINES.videoI2V : ENGINES.videoT2V;
    const { modelCfg, usePremium } = decideEngine(license, flowKey, enginePair);
    const jobId = crypto.randomUUID();
    const referenceCount = Number(reference_count) || (image ? 1 : 0);
    const estimatedCostUsd = ESTIMATED_COST_USD[modelCfg.id] ?? 0.25;

    const reservation = await reserveGenerationAtomic(env, {
      licenseKey: license.key,
      idempotencyKey,
      jobId,
      flow: image ? 'i2v' : 't2v',
      provider: 'fal',
      modelId: modelCfg.id,
      durationSeconds,
      aspectRatio: ratio,
      referenceCount,
      referenceStrategy: reference_strategy,
      estimatedCostUsd,
      maxActiveJobs: 2,
      metadata: { flow: image ? 'i2v' : 't2v', reference_count: referenceCount },
    });

    if (reservation.duplicate) {
      const existing = await getGenerationJob(env, reservation.jobId);
      if (!existing?.task_id) return err('Generation idempotency record tidak lengkap, coba lagi.', 409);
      return json({
        taskId: existing.task_id,
        provider: existing.provider || 'fal',
        status: existing.status,
        duplicate: true,
        duration_seconds: existing.duration_seconds,
        aspect_ratio: existing.aspect_ratio,
      });
    }
    if (!reservation.ok) {
      if (reservation.reason === 'ACTIVE_LIMIT') {
        return err('Maksimal 2 video generation aktif per license. Tunggu job sebelumnya selesai.', 429);
      }
      if (reservation.reason === 'QUOTA_UNAVAILABLE') {
        return err('Kredit video habis atau sedang dicadangkan oleh generation lain.', 402);
      }
      return err('Quota safety layer belum siap. Generation tidak dikirim ke provider.', 503);
    }

    const spend = await checkAndRecordSpend(env, modelCfg.id);
    if (!spend.allowed) {
      await settleGenerationAtomic(env, {
        licenseKey: license.key, jobId, attemptId: reservation.attemptId,
        creditType: 'video', settlement: 'RELEASE',
        errorCode: 'COST_BUDGET_EXHAUSTED', errorMessage: 'Batas biaya API harian tercapai',
      });
      return err('Batas biaya API harian tercapai. Coba lagi besok atau hubungi admin.', 503);
    }

    let submitData;
    try {
      submitData = await submitVideo(modelCfg, { prompt, image, ratio, duration: durationSeconds }, env);
    } catch {
      await settleGenerationAtomic(env, {
        licenseKey: license.key, jobId, attemptId: reservation.attemptId,
        creditType: 'video', settlement: 'RELEASE',
        errorCode: 'MEDIA_SUBMIT_FAILED', errorMessage: 'Layanan media gagal menerima permintaan video',
      });
      return err('Layanan media gagal menerima permintaan video. Kuota tidak dipotong.', 502);
    }

    // Video selalu async (proses 1-3 menit) — langsung balikin taskId
    const taskId = encodeTaskId('video', modelCfg.id, submitData.request_id, {
      j: jobId, a: reservation.attemptId,
    });
    await updateGenerationJob(env, jobId, {
      status: 'SUBMITTED', requestId: submitData.request_id, taskId,
    });
    await updateGenerationAttempt(env, reservation.attemptId, {
      status: 'SUBMITTED', requestId: submitData.request_id,
    });
    await recordGenerationEvent(env, {
      jobId, eventType: 'SUBMITTED', fromStatus: 'RESERVED', toStatus: 'SUBMITTED',
      metadata: { request_id: submitData.request_id },
    });
    if (usePremium) await commitPremiumUsage(env, license, flowKey);
    return json({ taskId, provider: 'fal', duration_seconds: durationSeconds, aspect_ratio: ratio });
  } finally {
    await releaseLock(env, lockKey);
  }
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
    test: 'Media Service Key',
    ok: !!env.FAL_KEY,
    detail: env.FAL_KEY ? 'Key tersedia' : 'Media service key belum di-set di environment variables',
  });

  const activeProvider = selectedProvider(env);
  const activeConfig = providerConfig(env, activeProvider);
  results.push({
    test: 'Language Service Config',
    ok: activeConfig.ready,
    detail: activeConfig.ready
      ? 'Konfigurasi layanan tersedia'
      : 'Konfigurasi layanan bahasa belum lengkap',
  });

  try {
    const testUrl = `https://queue.fal.run/${ENGINES.imageGenerate.premium.id}/requests/00000000-0000-0000-0000-000000000000/status`;
    const res = await fetch(testUrl, { headers: falHeaders(env) });
    const authOk = res.status !== 401 && res.status !== 403;
    results.push({
      test: 'Media Service Connectivity',
      ok: authOk,
      detail: authOk ? `Terhubung ke media service (HTTP ${res.status}, auth OK)` : 'Media service menolak kredensial (401/403) — cek key di Settings → Variables',
    });
  } catch (e) {
    results.push({ test: 'Media Service Connectivity', ok: false, detail: 'Media service tidak dapat dihubungi' });
  }

  try {
    if (!env.hc_kv) throw new Error('KV binding tidak ditemukan');
    await env.hc_kv.get('__ping__');
    results.push({ test: 'License KV', ok: true, detail: 'KV namespace terhubung' });
  } catch (e) {
    results.push({ test: 'License KV', ok: false, detail: 'hc_kv belum di-bind ke Worker. Buka Settings → Variables → KV Namespace Bindings' });
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
      if (path === '/api/admin/migrate-kv-to-d1' && request.method === 'POST') return await handleD1Migration(request, env);
      if (path === '/api/brain/refine'    && request.method === 'POST') return await handleBrainRefineRoute(request, env);
      if (path === '/api/images/generate' && request.method === 'POST') return await handleImageGenerate(request, env);
      if (path === '/api/images/edit'     && request.method === 'POST') return await handleImageEdit(request, env);
      if (path.startsWith('/api/images/status/') && request.method === 'GET') return await handleImageEditPoll(request, env, parts);
      if (path === '/api/videos/generate' && request.method === 'POST') return await handleVideoGenerate(request, env);
      if (path.startsWith('/api/videos/status/') && request.method === 'GET') return await handleVideoPoll(request, env, parts);
      if (path === '/api/diagnostics'     && request.method === 'POST') return await handleDiagnostics(request, env);
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};
