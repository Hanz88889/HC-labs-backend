import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenerationAttempt,
  getIdempotencyRecord,
  recordGenerationEvent,
  recordValidationResult,
  reserveGenerationAtomic,
  settleGenerationAtomic,
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
