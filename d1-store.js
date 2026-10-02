const nowIso = () => new Date().toISOString();

function dbReady(env) {
  return !!env.HC_DB;
}

function creditsOf(entry = {}) {
  return {
    image: Number(entry.credits?.image ?? 0),
    video: Number(entry.credits?.video ?? 0),
  };
}

export function licenseEntryToRow(key, entry) {
  const credits = creditsOf(entry);
  const premium = entry.premiumUsage || {};
  return {
    license_key: key,
    email: entry.email || null,
    tier: entry.tier || 'STD',
    status: entry.status || 'active',
    credits_image: credits.image,
    credits_video: credits.video,
    limit_value: Number(entry.limit ?? 0),
    reset_date: entry.reset_date || null,
    premium_t2i: Number(premium.t2i ?? 0),
    premium_i2i: Number(premium.i2i ?? 0),
    premium_t2v: Number(premium.t2v ?? 0),
    premium_i2v: Number(premium.i2v ?? 0),
    bound_at: entry.bound_at || null,
    source_updated_at: nowIso(),
  };
}

export function rowToLicenseEntry(row) {
  if (!row) return null;
  return {
    email: row.email || undefined,
    tier: row.tier,
    status: row.status,
    credits: { image: row.credits_image, video: row.credits_video },
    limit: row.limit_value,
    reset_date: row.reset_date || undefined,
    premiumUsage: {
      t2i: row.premium_t2i,
      i2i: row.premium_i2i,
      t2v: row.premium_t2v,
      i2v: row.premium_i2v,
    },
    bound_at: row.bound_at || undefined,
  };
}

export async function getD1License(env, key) {
  if (!dbReady(env)) return null;
  const result = await env.HC_DB.prepare('SELECT * FROM licenses WHERE license_key = ?1').bind(key).first();
  return result ? { key, entry: rowToLicenseEntry(result), source: 'd1' } : null;
}

export async function upsertD1License(env, key, entry) {
  if (!dbReady(env)) return false;
  const r = licenseEntryToRow(key, entry);
  await env.HC_DB.prepare(`
    INSERT INTO licenses (
      license_key,email,tier,status,credits_image,credits_video,limit_value,reset_date,
      premium_t2i,premium_i2i,premium_t2v,premium_i2v,bound_at,source_updated_at,updated_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,CURRENT_TIMESTAMP)
    ON CONFLICT(license_key) DO UPDATE SET
      email=excluded.email,tier=excluded.tier,status=excluded.status,
      credits_image=excluded.credits_image,credits_video=excluded.credits_video,
      limit_value=excluded.limit_value,reset_date=excluded.reset_date,
      premium_t2i=excluded.premium_t2i,premium_i2i=excluded.premium_i2i,
      premium_t2v=excluded.premium_t2v,premium_i2v=excluded.premium_i2v,
      bound_at=excluded.bound_at,source_updated_at=excluded.source_updated_at,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    r.license_key, r.email, r.tier, r.status, r.credits_image, r.credits_video,
    r.limit_value, r.reset_date, r.premium_t2i, r.premium_i2i, r.premium_t2v,
    r.premium_i2v, r.bound_at, r.source_updated_at,
  ).run();
  return true;
}

export async function createGenerationJob(env, job) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT INTO generation_jobs (
      job_id,license_key,flow,status,provider,model_id,request_id,task_id,
      prompt_hash,duration_seconds,aspect_ratio,reference_count,reference_strategy
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
  `).bind(
    job.jobId, job.licenseKey, job.flow, job.status || 'SUBMITTED', job.provider || null,
    job.modelId || null, job.requestId || null, job.taskId || null, job.promptHash || null,
    job.durationSeconds ?? null, job.aspectRatio || null, job.referenceCount || 0,
    job.referenceStrategy || null,
  ).run();
  return true;
}

export async function updateGenerationJob(env, jobId, patch) {
  if (!dbReady(env) || !jobId) return false;
  const fields = [];
  const values = [];
  const allowed = {
    status: 'status', requestId: 'request_id', taskId: 'task_id', resultUrl: 'result_url',
    errorCode: 'error_code', errorMessage: 'error_message', completedAt: 'completed_at',
  };
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return true;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(jobId);
  await env.HC_DB.prepare(`UPDATE generation_jobs SET ${fields.join(', ')} WHERE job_id = ?`).bind(...values).run();
  return true;
}

export async function recordQuotaLedger(env, event) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT OR IGNORE INTO quota_ledger
      (ledger_id,license_key,job_id,event_type,credit_type,units,estimated_cost_usd,idempotency_key,metadata_json)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
  `).bind(
    event.ledgerId || crypto.randomUUID(), event.licenseKey, event.jobId || null,
    event.eventType, event.creditType || null, event.units || 0, event.estimatedCostUsd || 0,
    event.idempotencyKey, event.metadata ? JSON.stringify(event.metadata) : null,
  ).run();
  return true;
}

export async function migrateKvLicense(env, key, raw) {
  if (!dbReady(env) || !key || !raw) return false;
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object' || !entry.credits || !entry.tier) return false;
    await upsertD1License(env, key, entry);
    return true;
  } catch {
    return false;
  }
}

export function d1Status(env) {
  return { configured: dbReady(env), binding: 'HC_DB' };
}
