import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countActiveGenerationJobs,
  createGenerationAttempt,
  acquireOperationLock,
  getD1QuotaBalances,
  getIdempotencyRecord,
  recordGenerationEvent,
  recordValidationResult,
  reserveGenerationAtomic,
  reserveDailySpendAtomic,
  releaseOperationLock,
  settleGenerationAtomic,
  updateGenerationAttempt,
} from '../d1-store.js';

function fakeDb({ batchResults = [], existing = null } = {}) {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
        async first() { return existing; },
        async all() { return { results: existing?.quotaBalances || [] }; },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      return batchResults.length ? batchResults : statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
}

test('reserveGenerationAtomic builds one D1 batch for reservation and job creation', async () => {
  const db = fakeDb({ batchResults: Array.from({ length: 7 }, () => ({ success: true, meta: { changes: 1 } })) });
  const out = await reserveGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-001',
    idempotencyKey: 'req-001',
    jobId: 'JOB-001',
    flow: 'i2v',
    provider: 'fal',
    modelId: 'fal-ai/wan-i2v',
    requestId: 'provider-001',
    taskId: 'task-001',
    durationSeconds: 8,
    aspectRatio: '9:16',
    estimatedCostUsd: 0.2,
    referenceCount: 2,
    referenceStrategy: 'contact-sheet',
  });

  assert.deepEqual(out, {
    ok: true,
    duplicate: false,
    jobId: 'JOB-001',
    attemptId: out.attemptId,
    idempotencyKey: 'req-001',
  });
  assert.equal(db.prepared.length, 7);
  assert.match(db.prepared[1].sql, /UPDATE quota_balances/);
  assert.match(db.prepared[1].sql, /available_units >= 1/);
  assert.match(db.prepared[1].sql, /COUNT\(\*\) FROM generation_jobs/);
  assert.match(db.prepared[1].sql, /< \?4/);
  assert.match(db.prepared[0].sql, /CASE WHEN \?2 = 'image' THEN credits_image ELSE credits_video END/);
  assert.match(db.prepared[2].sql, /INSERT INTO generation_jobs/);
  assert.match(db.prepared[2].sql, /WHERE changes\(\) > 0/);
  assert.match(db.prepared[5].sql, /INSERT INTO quota_ledger/);
});

test('reserveGenerationAtomic returns the existing job for a duplicate idempotency key', async () => {
  const db = fakeDb({
    batchResults: [
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
    ],
    existing: { idempotency_key: 'req-dup', job_id: 'JOB-OLD', status: 'ACTIVE' },
  });
  const out = await reserveGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-001', idempotencyKey: 'req-dup', jobId: 'JOB-NEW', flow: 't2v',
  });
  assert.deepEqual(out, { ok: true, duplicate: true, jobId: 'JOB-OLD', idempotencyKey: 'req-dup' });
});

test('reserveGenerationAtomic refuses to operate without D1', async () => {
  const out = await reserveGenerationAtomic({}, {
    licenseKey: 'HC-001', idempotencyKey: 'req-001', jobId: 'JOB-001', flow: 't2v',
  });
  assert.deepEqual(out, { ok: false, reason: 'D1_UNAVAILABLE' });
});

test('records generation event, attempt, and validation through D1', async () => {
  const db = fakeDb();
  const env = { HC_DB: db };
  assert.equal(await recordGenerationEvent(env, {
    eventId: 'EV-001', jobId: 'JOB-001', eventType: 'PROCESSING',
    fromStatus: 'QUEUED', toStatus: 'PROCESSING', metadata: { stage: 'rendering' },
  }), true);
  assert.equal(await createGenerationAttempt(env, {
    attemptId: 'ATT-001', jobId: 'JOB-001', attemptNo: 1, status: 'SUBMITTED',
    provider: 'fal', modelId: 'model-x', requestId: 'provider-001', estimatedCostUsd: 0.2,
  }), true);
  assert.equal(await recordValidationResult(env, {
    validationId: 'VAL-001', jobId: 'JOB-001', attemptId: 'ATT-001',
    validationType: 'technical', status: 'PASS', details: { duration: 8 },
  }), true);
  assert.equal(db.prepared.length, 3);
  assert.match(db.prepared[0].sql, /generation_events/);
  assert.match(db.prepared[1].sql, /generation_attempts/);
  assert.match(db.prepared[2].sql, /validation_results/);
});

test('settles a reserved generation exactly once', async () => {
  const db = fakeDb({
    batchResults: Array.from({ length: 4 }, () => ({ success: true, meta: { changes: 1 } })),
  });
  const out = await settleGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-001', jobId: 'JOB-001', settlement: 'COMMIT',
    resultUrl: 'https://example.com/video.mp4', actualCostUsd: 0.22,
  });
  assert.deepEqual(out, { ok: true, duplicate: false, settlement: 'COMMIT', jobId: 'JOB-001' });
  assert.match(db.prepared[0].sql, /INSERT OR IGNORE INTO quota_ledger/);
  assert.match(db.prepared[1].sql, /reserved_units = reserved_units - 1/);
  assert.match(db.prepared[2].sql, /status = \?1/);
});

test('returns NO_RESERVATION when settlement has no matching reserved balance', async () => {
  const db = fakeDb({
    batchResults: Array.from({ length: 4 }, () => ({ success: true, meta: { changes: 0 } })),
  });
  const out = await settleGenerationAtomic({ HC_DB: db }, {
    licenseKey: 'HC-001', jobId: 'JOB-OLD', settlement: 'RELEASE',
  });
  assert.deepEqual(out, { ok: false, reason: 'NO_RESERVATION', jobId: 'JOB-OLD' });
});

test('reads an idempotency record by normalized key', async () => {
  const db = fakeDb({ existing: { idempotency_key: 'req-001', job_id: 'JOB-001' } });
  const result = await getIdempotencyRecord({ HC_DB: db }, ' req-001 ');
  assert.equal(result.job_id, 'JOB-001');
  assert.equal(db.prepared[0].params[0], 'req-001');
});

test('counts active jobs and updates provider attempt status', async () => {
  const db = fakeDb({ existing: { active_jobs: 2 } });
  const env = { HC_DB: db };
  assert.equal(await countActiveGenerationJobs(env, 'HC-001'), 2);
  assert.equal(await updateGenerationAttempt(env, 'ATT-001', {
    status: 'SUBMITTED', requestId: 'provider-001',
  }), true);
  assert.match(db.prepared[0].sql, /COUNT\(\*\) AS active_jobs/);
  assert.match(db.prepared[1].sql, /UPDATE generation_attempts/);
});

test('reads current image and video quota balances from D1', async () => {
  const db = fakeDb({ existing: {
    quotaBalances: [
      { credit_type: 'image', available_units: 4 },
      { credit_type: 'video', available_units: 2 },
    ],
  } });
  const balances = await getD1QuotaBalances({ HC_DB: db }, 'HC-001');
  assert.deepEqual(balances, [
    { credit_type: 'image', available_units: 4 },
    { credit_type: 'video', available_units: 2 },
  ]);
  assert.match(db.prepared[0].sql, /FROM quota_balances/);
});

test('acquires and releases an owner-token D1 operation lock', async () => {
  const db = fakeDb();
  const token = await acquireOperationLock({ HC_DB: db }, 'inflight:HC-001:t2i', 60);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.match(db.prepared[0].sql, /DELETE FROM operation_locks/);
  assert.match(db.prepared[1].sql, /INSERT OR IGNORE INTO operation_locks/);
  assert.equal(await releaseOperationLock({ HC_DB: db }, 'inflight:HC-001:t2i', token), true);
});

test('reserves daily spend atomically and recognizes duplicate reservation', async () => {
  const db = fakeDb();
  const out = await reserveDailySpendAtomic({ HC_DB: db }, {
    dayKey: 'spend:2026-10-04', reservationId: 'generation:JOB-001', amountUsd: 0.2, capUsd: 5,
  });
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  assert.match(db.prepared[1].sql, /spend_reservations/);
  assert.match(db.prepared[2].sql, /spent_usd = spent_usd \+ \?1/);
});
