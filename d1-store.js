const nowIso = () => new Date().toISOString();

import { normalizeIdempotencyKey } from './job-lifecycle.js';

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

export async function getD1QuotaBalances(env, key) {
  if (!dbReady(env) || !key) return null;
  const result = await env.HC_DB.prepare(`
    SELECT credit_type, available_units, reserved_units, committed_units, released_units
    FROM quota_balances WHERE license_key = ?1
  `).bind(key).all();
  return result?.results || [];
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

export async function acquireOperationLock(env, lockKey, ttlSeconds = 60) {
  if (!dbReady(env) || !lockKey) return null;
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || 60);
  const results = await env.HC_DB.batch([
    env.HC_DB.prepare('DELETE FROM operation_locks WHERE lock_key = ?1 AND expires_at_epoch <= ?2').bind(lockKey, Math.floor(Date.now() / 1000)),
    env.HC_DB.prepare(`
      INSERT OR IGNORE INTO operation_locks (lock_key, token, expires_at_epoch)
      VALUES (?1, ?2, ?3)
    `).bind(lockKey, token, expiresAt),
  ]);
  return Number(results?.[1]?.meta?.changes || 0) === 1 ? token : null;
}

export async function releaseOperationLock(env, lockKey, token) {
  if (!dbReady(env) || !lockKey || !token) return false;
  const result = await env.HC_DB.prepare(
    'DELETE FROM operation_locks WHERE lock_key = ?1 AND token = ?2',
  ).bind(lockKey, token).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function reserveDailySpendAtomic(env, input) {
  if (!dbReady(env)) return { ok: false, reason: 'D1_UNAVAILABLE' };
  const dayKey = input.dayKey;
  const reservationId = input.reservationId;
  const amountUsd = Number(input.amountUsd || 0);
  const capUsd = Number(input.capUsd || 0);
  if (!dayKey || !reservationId || !(amountUsd > 0) || !(capUsd > 0)) {
    return { ok: false, reason: 'INVALID_SPEND_INPUT' };
  }

  const results = await env.HC_DB.batch([
    env.HC_DB.prepare(`
      INSERT OR IGNORE INTO spend_counters (day_key, spent_usd, cap_usd)
      VALUES (?1, 0, ?2)
    `).bind(dayKey, capUsd),
    env.HC_DB.prepare(`
      INSERT OR IGNORE INTO spend_reservations (reservation_id, day_key, amount_usd)
      SELECT ?1, ?2, ?3
      WHERE EXISTS (
        SELECT 1 FROM spend_counters
        WHERE day_key = ?2 AND spent_usd + ?3 <= cap_usd
      )
    `).bind(reservationId, dayKey, amountUsd),
    env.HC_DB.prepare(`
      UPDATE spend_counters
      SET spent_usd = spent_usd + ?1, updated_at = CURRENT_TIMESTAMP
      WHERE day_key = ?2 AND changes() = 1
    `).bind(amountUsd, dayKey),
  ]);

  if (Number(results?.[2]?.meta?.changes || 0) === 1) {
    return { ok: true, duplicate: false, dayKey, reservationId, amountUsd };
  }

  const existing = await env.HC_DB.prepare(
    'SELECT reservation_id, amount_usd FROM spend_reservations WHERE reservation_id = ?1',
  ).bind(reservationId).first();
  if (existing) return { ok: true, duplicate: true, dayKey, reservationId, amountUsd: Number(existing.amount_usd) };
  return { ok: false, reason: 'SPEND_CAP_EXCEEDED' };
}

export async function getIdempotencyRecord(env, key) {
  if (!dbReady(env)) return null;
  const normalized = normalizeIdempotencyKey(key);
  return env.HC_DB.prepare(`
    SELECT idempotency_key, license_key, job_id, request_hash, status, created_at, updated_at
    FROM idempotency_keys WHERE idempotency_key = ?1
  `).bind(normalized).first();
}

export async function recordGenerationEvent(env, event) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT OR IGNORE INTO generation_events
      (event_id, job_id, event_type, from_status, to_status, metadata_json)
    VALUES (?1,?2,?3,?4,?5,?6)
  `).bind(
    event.eventId || crypto.randomUUID(), event.jobId, event.eventType,
    event.fromStatus || null, event.toStatus || null,
    event.metadata ? JSON.stringify(event.metadata) : null,
  ).run();
  return true;
}

export async function createGenerationAttempt(env, attempt) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT INTO generation_attempts (
      attempt_id,job_id,attempt_no,status,provider,model_id,request_id,
      input_duration_seconds,output_duration_seconds,resolution,
      estimated_cost_usd,actual_cost_usd,currency,metadata_json
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
  `).bind(
    attempt.attemptId || crypto.randomUUID(), attempt.jobId, attempt.attemptNo,
    attempt.status || 'CREATED', attempt.provider || null, attempt.modelId || null,
    attempt.requestId || null, attempt.inputDurationSeconds ?? null,
    attempt.outputDurationSeconds ?? null, attempt.resolution || null,
    attempt.estimatedCostUsd ?? 0, attempt.actualCostUsd ?? null,
    attempt.currency || 'USD', attempt.metadata ? JSON.stringify(attempt.metadata) : null,
  ).run();
  return true;
}

export async function recordValidationResult(env, result) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT INTO validation_results
      (validation_id,job_id,attempt_id,validation_type,status,failure_code,details_json)
    VALUES (?1,?2,?3,?4,?5,?6,?7)
  `).bind(
    result.validationId || crypto.randomUUID(), result.jobId, result.attemptId || null,
    result.validationType, result.status, result.failureCode || null,
    result.details ? JSON.stringify(result.details) : null,
  ).run();
  return true;
}

export async function recordGenerationAsset(env, asset) {
  if (!dbReady(env)) return false;
  await env.HC_DB.prepare(`
    INSERT OR IGNORE INTO generation_assets
      (asset_id,job_id,attempt_id,storage_key,content_type,byte_size)
    VALUES (?1,?2,?3,?4,?5,?6)
  `).bind(
    asset.assetId || crypto.randomUUID(), asset.jobId, asset.attemptId || null,
    asset.storageKey, asset.contentType, Number(asset.byteSize || 0),
  ).run();
  return true;
}

export async function reserveGenerationAtomic(env, input) {
  if (!dbReady(env)) return { ok: false, reason: 'D1_UNAVAILABLE' };
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const jobId = input.jobId || crypto.randomUUID();
  const attemptId = input.attemptId || crypto.randomUUID();
  const ledgerId = input.ledgerId || crypto.randomUUID();
  const eventId = input.eventId || crypto.randomUUID();
  const creditType = input.creditType || 'video';
  const maxActiveJobs = Number(input.maxActiveJobs ?? 2);
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  const statements = [
    env.HC_DB.prepare(`
      INSERT OR IGNORE INTO quota_balances (license_key,credit_type,available_units)
      SELECT license_key,?2,
             CASE WHEN ?2 = 'image' THEN credits_image ELSE credits_video END
      FROM licenses WHERE license_key = ?1
    `).bind(input.licenseKey, creditType),
    env.HC_DB.prepare(`
      UPDATE quota_balances
      SET available_units = available_units - 1,
          reserved_units = reserved_units + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE license_key = ?1
        AND credit_type = ?2
        AND available_units >= 1
        AND NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?3)
        AND (
          SELECT COUNT(*) FROM generation_jobs
          WHERE license_key = ?1
            AND status IN ('RESERVED','PLANNED','ROUTING','SUBMITTING','SUBMITTED',
                           'QUEUED','PROCESSING','DOWNLOADING','VALIDATING_OUTPUT',
                           'CONTENT_VALIDATION','REFINING','RETRY')
        ) < ?4
    `).bind(input.licenseKey, creditType, idempotencyKey, maxActiveJobs),
    env.HC_DB.prepare(`
      INSERT INTO generation_jobs (
        job_id,license_key,flow,status,provider,model_id,request_id,task_id,
        prompt_hash,duration_seconds,aspect_ratio,reference_count,reference_strategy
      )
      SELECT ?1,?2,?3,'RESERVED',?4,?5,?6,?7,?8,?9,?10,?11,?12
      WHERE changes() > 0
    `).bind(
      jobId, input.licenseKey, input.flow, input.provider || null, input.modelId || null,
      input.requestId || null, input.taskId || null, input.promptHash || null,
      input.durationSeconds ?? null, input.aspectRatio || null,
      input.referenceCount || 0, input.referenceStrategy || null,
    ),
    env.HC_DB.prepare(`
      INSERT INTO idempotency_keys
        (idempotency_key,license_key,job_id,request_hash,status)
      SELECT ?1,?2,?3,?4,'ACTIVE' WHERE changes() > 0
    `).bind(idempotencyKey, input.licenseKey, jobId, input.requestHash || null),
    env.HC_DB.prepare(`
      INSERT INTO generation_attempts
        (attempt_id,job_id,attempt_no,status,provider,model_id,request_id,
         input_duration_seconds,resolution,estimated_cost_usd,currency,metadata_json)
      SELECT ?1,?2,1,'CREATED',?3,?4,?5,?6,?7,?8,?9,?10
      WHERE changes() > 0
    `).bind(
      attemptId, jobId, input.provider || null, input.modelId || null,
      input.requestId || null, input.inputDurationSeconds ?? null,
      input.resolution || null, input.estimatedCostUsd ?? 0,
      input.currency || 'USD', metadataJson,
    ),
    env.HC_DB.prepare(`
      INSERT INTO quota_ledger
        (ledger_id,license_key,job_id,event_type,credit_type,units,estimated_cost_usd,idempotency_key,metadata_json)
      SELECT ?1,?2,?3,'RESERVE',?4,1,?5,?6,?7
      WHERE changes() > 0
    `).bind(
      ledgerId, input.licenseKey, jobId, creditType, input.estimatedCostUsd ?? 0,
      `reserve:${idempotencyKey}`, metadataJson,
    ),
    env.HC_DB.prepare(`
      INSERT INTO generation_events
        (event_id,job_id,event_type,from_status,to_status,metadata_json)
      SELECT ?1,?2,'RESERVED','VALIDATING_REQUEST','RESERVED',?3
      WHERE changes() > 0
    `).bind(eventId, jobId, metadataJson),
  ];

  const results = await env.HC_DB.batch(statements);
  const reservationResult = results?.[1]?.meta || {};
  const jobResult = results?.[2]?.meta || {};
  if (Number(reservationResult.changes || 0) !== 1 || Number(jobResult.changes || 0) !== 1) {
    const existing = await getIdempotencyRecord(env, idempotencyKey);
    if (existing) {
      if (existing.license_key !== input.licenseKey) return { ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT' };
      if (existing.request_hash && input.requestHash && existing.request_hash !== input.requestHash) {
        return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
      }
      return { ok: true, duplicate: true, jobId: existing.job_id, idempotencyKey };
    }
    if (await countActiveGenerationJobs(env, input.licenseKey) >= maxActiveJobs) {
      return { ok: false, reason: 'ACTIVE_LIMIT' };
    }
    return { ok: false, reason: 'QUOTA_UNAVAILABLE' };
  }
  return { ok: true, duplicate: false, jobId, attemptId, idempotencyKey };
}

export async function getGenerationJob(env, jobId) {
  if (!dbReady(env) || !jobId) return null;
  return env.HC_DB.prepare(`
    SELECT job_id,license_key,flow,status,provider,model_id,request_id,task_id,
           result_url,error_code,error_message,duration_seconds,aspect_ratio,
           reference_count,reference_strategy,created_at,updated_at,completed_at
    FROM generation_jobs WHERE job_id = ?1
  `).bind(jobId).first();
}

export async function getGenerationAttempt(env, attemptId) {
  if (!dbReady(env) || !attemptId) return null;
  return env.HC_DB.prepare(`
    SELECT attempt_id,job_id,attempt_no,status,provider,model_id,request_id,
           error_code,error_message,estimated_cost_usd,actual_cost_usd,created_at,completed_at
    FROM generation_attempts WHERE attempt_id = ?1
  `).bind(attemptId).first();
}

export async function countActiveGenerationJobs(env, licenseKey) {
  if (!dbReady(env) || !licenseKey) return 0;
  const row = await env.HC_DB.prepare(`
    SELECT COUNT(*) AS active_jobs FROM generation_jobs
    WHERE license_key = ?1
      AND status IN ('RESERVED','PLANNED','ROUTING','SUBMITTING','SUBMITTED',
                     'QUEUED','PROCESSING','DOWNLOADING','VALIDATING_OUTPUT',
                     'CONTENT_VALIDATION','REFINING','RETRY')
  `).bind(licenseKey).first();
  return Number(row?.active_jobs || 0);
}

export async function updateGenerationAttempt(env, attemptId, patch = {}) {
  if (!dbReady(env) || !attemptId) return false;
  const fields = [];
  const values = [];
  const allowed = {
    status: 'status', requestId: 'request_id', errorCode: 'error_code',
    errorMessage: 'error_message', actualCostUsd: 'actual_cost_usd',
    outputDurationSeconds: 'output_duration_seconds', completedAt: 'completed_at',
  };
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return true;
  values.push(attemptId);
  await env.HC_DB.prepare(`
    UPDATE generation_attempts SET ${fields.join(', ')} WHERE attempt_id = ?
  `).bind(...values).run();
  return true;
}

export async function getQuotaLedgerByIdempotencyKey(env, idempotencyKey) {
  if (!dbReady(env) || !idempotencyKey) return null;
  return env.HC_DB.prepare(`
    SELECT ledger_id,license_key,job_id,event_type,credit_type,units,metadata_json
    FROM quota_ledger WHERE idempotency_key = ?1
  `).bind(idempotencyKey).first();
}

export async function settleGenerationAtomic(env, input) {
  if (!dbReady(env)) return { ok: false, reason: 'D1_UNAVAILABLE' };
  if (!['COMMIT', 'RELEASE'].includes(input.settlement)) {
    throw new Error(`Invalid settlement: ${input.settlement}`);
  }
  const jobId = input.jobId;
  const creditType = input.creditType || 'video';
  const settlement = input.settlement;
  const ledgerKey = `settle:${jobId}:${settlement}`;
  const ledgerId = input.ledgerId || crypto.randomUUID();
  const eventId = input.eventId || crypto.randomUUID();
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const nextJobStatus = settlement === 'COMMIT' ? 'COMPLETED' : (input.terminalStatus || 'FAILED');
  if (!['COMPLETED', 'FAILED', 'EXPIRED'].includes(nextJobStatus)) {
    throw new Error(`Invalid terminal status: ${nextJobStatus}`);
  }

  const results = await env.HC_DB.batch([
    env.HC_DB.prepare(`
      INSERT OR IGNORE INTO quota_ledger
        (ledger_id,license_key,job_id,event_type,credit_type,units,estimated_cost_usd,idempotency_key,metadata_json)
      SELECT ?1,?2,?3,?4,?5,0,?6,?7,?8
      WHERE EXISTS (
        SELECT 1 FROM quota_balances
        WHERE license_key = ?2 AND credit_type = ?5 AND reserved_units >= 1
      )
      AND EXISTS (
        SELECT 1 FROM generation_jobs
        WHERE job_id = ?3 AND license_key = ?2
          AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM quota_ledger
        WHERE job_id = ?3 AND event_type IN ('COMMIT','RELEASE')
      )
    `).bind(
      ledgerId, input.licenseKey, jobId, settlement, creditType,
      input.actualCostUsd ?? input.estimatedCostUsd ?? 0, ledgerKey, metadataJson,
    ),
    env.HC_DB.prepare(`
      UPDATE quota_balances
      SET reserved_units = reserved_units - 1,
          ${settlement === 'COMMIT' ? '' : 'available_units = available_units + 1,'}
          ${settlement === 'COMMIT' ? 'committed_units' : 'released_units'} =
            ${settlement === 'COMMIT' ? 'committed_units' : 'released_units'} + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE license_key = ?1 AND credit_type = ?2 AND reserved_units >= 1
        AND changes() = 1
        AND EXISTS (SELECT 1 FROM quota_ledger WHERE idempotency_key = ?3)
    `).bind(input.licenseKey, creditType, ledgerKey),
    env.HC_DB.prepare(`
      UPDATE generation_jobs
      SET status = ?1, result_url = COALESCE(?2,result_url), error_code = ?3,
          error_message = ?4, completed_at = CASE WHEN ?1 IN ('COMPLETED','FAILED','EXPIRED')
            THEN COALESCE(completed_at,CURRENT_TIMESTAMP) ELSE completed_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?5 AND changes() = 1
    `).bind(
      nextJobStatus, input.resultUrl || null, input.errorCode || null,
      input.errorMessage || null, jobId,
    ),
    env.HC_DB.prepare(`
      INSERT INTO generation_events
        (event_id,job_id,event_type,from_status,to_status,metadata_json)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE changes() = 1
    `).bind(eventId, jobId, settlement, input.fromStatus || null, nextJobStatus, metadataJson),
    env.HC_DB.prepare(`
      UPDATE generation_attempts
      SET status = ?1, actual_cost_usd = COALESCE(?2,actual_cost_usd),
          error_code = ?3, error_message = ?4,
          completed_at = COALESCE(?5,CURRENT_TIMESTAMP)
      WHERE attempt_id = ?6 AND changes() = 1
    `).bind(
      input.attemptStatus || (settlement === 'COMMIT' ? 'COMPLETED' : 'FAILED'), input.actualCostUsd ?? null,
      input.errorCode || null, input.errorMessage || null, input.completedAt || null,
      input.attemptId || null,
    ),
  ]);

  const ledgerChanged = Number(results?.[0]?.meta?.changes || 0) === 1;
  const balanceChanged = Number(results?.[1]?.meta?.changes || 0) === 1;
  if (ledgerChanged && balanceChanged) {
    return { ok: true, duplicate: false, settlement, jobId };
  }

  const existing = await getQuotaLedgerByIdempotencyKey(env, ledgerKey);
  if (existing) return { ok: true, duplicate: true, settlement, jobId };
  return { ok: false, reason: 'NO_RESERVATION', jobId };
}


export async function upsertModelRegistry(env, model) {
  if (!dbReady(env) || !model?.modelKey || !model?.modelId) return false;
  await env.HC_DB.prepare(`
    INSERT INTO model_registry (model_key,provider,model_id,label,active,updated_at)
    VALUES (?1,?2,?3,?4,?5,CURRENT_TIMESTAMP)
    ON CONFLICT(model_key) DO UPDATE SET
      provider=excluded.provider, model_id=excluded.model_id, label=excluded.label,
      active=excluded.active, updated_at=CURRENT_TIMESTAMP
  `).bind(
    model.modelKey, model.provider || 'unknown', model.modelId, model.label || model.modelKey,
    model.active === false ? 0 : 1,
  ).run();
  return true;
}

export async function recordModelCapability(env, capability) {
  if (!dbReady(env) || !capability?.modelKey || !capability?.name) return false;
  await env.HC_DB.prepare(`
    INSERT INTO model_capabilities (model_key,capability,supported,metadata_json)
    VALUES (?1,?2,?3,?4)
    ON CONFLICT(model_key,capability) DO UPDATE SET
      supported=excluded.supported, metadata_json=excluded.metadata_json
  `).bind(
    capability.modelKey, capability.name, capability.supported === false ? 0 : 1,
    capability.metadata ? JSON.stringify(capability.metadata) : null,
  ).run();
  return true;
}

export async function recordModelPricing(env, pricing) {
  if (!dbReady(env) || !pricing?.modelKey || !pricing?.pricingKey) return false;
  await env.HC_DB.prepare(`
    INSERT INTO model_pricing (model_key,pricing_key,unit,amount_usd,effective_from,effective_until)
    VALUES (?1,?2,?3,?4,COALESCE(?5,CURRENT_TIMESTAMP),?6)
  `).bind(
    pricing.modelKey, pricing.pricingKey, pricing.unit || 'request', Number(pricing.amountUsd || 0),
    pricing.effectiveFrom || null, pricing.effectiveUntil || null,
  ).run();
  return true;
}

export async function recordCostRecord(env, cost) {
  if (!dbReady(env) || !cost?.provider) return false;
  await env.HC_DB.prepare(`
    INSERT OR IGNORE INTO cost_records
      (cost_record_id,job_id,attempt_id,model_key,provider,estimated_cost_usd,actual_cost_usd,currency,usage_json)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
  `).bind(
    cost.costRecordId || crypto.randomUUID(), cost.jobId || null, cost.attemptId || null,
    cost.modelKey || null, cost.provider, Number(cost.estimatedCostUsd || 0),
    cost.actualCostUsd == null ? null : Number(cost.actualCostUsd), cost.currency || 'USD',
    cost.usage ? JSON.stringify(cost.usage) : null,
  ).run();
  return true;
}

export async function listPersistedModels(env) {
  if (!dbReady(env)) return [];
  const result = await env.HC_DB.prepare(`
    SELECT model_key,provider,model_id,label,active FROM model_registry ORDER BY model_key
  `).all();
  return result?.results || [];
}

export async function getLatestGenerationAttempt(env, jobId) {
  if (!dbReady(env) || !jobId) return null;
  return env.HC_DB.prepare(`
    SELECT attempt_id,job_id,attempt_no,status,provider,model_id,request_id,
           error_code,error_message,estimated_cost_usd,actual_cost_usd,created_at,completed_at
    FROM generation_attempts WHERE job_id = ?1
    ORDER BY attempt_no DESC, created_at DESC LIMIT 1
  `).bind(jobId).first();
}

export async function countGenerationAttempts(env, jobId) {
  if (!dbReady(env) || !jobId) return 0;
  const row = await env.HC_DB.prepare(
    'SELECT COUNT(*) AS attempts FROM generation_attempts WHERE job_id = ?1',
  ).bind(jobId).first();
  return Number(row?.attempts || 0);
}

export async function listStaleActiveJobs(env, olderThanSeconds, limit = 25) {
  if (!dbReady(env)) return [];
  const seconds = Math.max(60, Math.floor(Number(olderThanSeconds) || 900));
  const result = await env.HC_DB.prepare(`
    SELECT job_id, license_key, flow, status FROM generation_jobs
    WHERE status IN ('RESERVED','PLANNED','ROUTING','SUBMITTING','SUBMITTED',
                     'QUEUED','PROCESSING','DOWNLOADING','VALIDATING_OUTPUT',
                     'CONTENT_VALIDATION','REFINING','RETRY')
      AND created_at <= datetime('now', ?1)
    ORDER BY created_at ASC LIMIT ?2
  `).bind(`-${seconds} seconds`, Math.max(1, Math.min(100, Number(limit) || 25))).all();
  return result?.results || [];
}

export async function expireStaleGenerations(env, options = {}) {
  if (!dbReady(env)) return { scanned: 0, released: 0, failed: 0 };
  const stale = await listStaleActiveJobs(env, options.olderThanSeconds, options.limit);
  let released = 0;
  let failed = 0;
  for (const job of stale) {
    const attempt = await getLatestGenerationAttempt(env, job.job_id).catch(() => null);
    const outcome = await settleGenerationAtomic(env, {
      licenseKey: job.license_key,
      jobId: job.job_id,
      attemptId: attempt?.attempt_id || null,
      creditType: job.flow === 't2i' || job.flow === 'i2i' ? 'image' : 'video',
      settlement: 'RELEASE',
      terminalStatus: 'EXPIRED',
      attemptStatus: 'EXPIRED',
      fromStatus: job.status,
      errorCode: 'REAPED_TIMEOUT',
      errorMessage: 'Generation dihentikan otomatis karena melewati batas waktu',
    }).catch(() => ({ ok: false }));
    if (outcome.ok) released++; else failed++;
  }
  await env.HC_DB.prepare('DELETE FROM operation_locks WHERE expires_at_epoch <= ?1')
    .bind(Math.floor(Date.now() / 1000)).run().catch(() => null);
  return { scanned: stale.length, released, failed };
}
