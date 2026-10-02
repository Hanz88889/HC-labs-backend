import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATION_POLICY,
  JOB_STATES,
  QUOTA_EVENTS,
  QUOTA_STATES,
  assertSingleFinalSettlement,
  canTransitionJob,
  idempotencyRecord,
  elapsedSeconds,
  normalizeIdempotencyKey,
  retryDecision,
  settleQuota,
  shouldExpireGeneration,
  transitionJob,
} from '../job-lifecycle.js';

test('allows the official happy-path job lifecycle', () => {
  const path = [
    JOB_STATES.CREATED,
    JOB_STATES.VALIDATING_REQUEST,
    JOB_STATES.RESERVED,
    JOB_STATES.PLANNED,
    JOB_STATES.ROUTING,
    JOB_STATES.SUBMITTING,
    JOB_STATES.SUBMITTED,
    JOB_STATES.QUEUED,
    JOB_STATES.PROCESSING,
    JOB_STATES.DOWNLOADING,
    JOB_STATES.VALIDATING_OUTPUT,
    JOB_STATES.CONTENT_VALIDATION,
    JOB_STATES.COMPLETED,
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.equal(canTransitionJob(path[i], path[i + 1]), true);
  }
});

test('rejects terminal job transitions and backward transitions', () => {
  assert.equal(canTransitionJob(JOB_STATES.COMPLETED, JOB_STATES.PROCESSING), false);
  assert.equal(canTransitionJob(JOB_STATES.PROCESSING, JOB_STATES.RESERVED), false);
  assert.throws(
    () => transitionJob({ status: JOB_STATES.COMPLETED }, JOB_STATES.PROCESSING),
    /Invalid job transition/,
  );
});

test('supports refinement retry without changing the logical job', () => {
  let job = { jobId: 'JOB-001', status: JOB_STATES.VALIDATING_OUTPUT };
  job = transitionJob(job, JOB_STATES.REFINING, { reason: 'MOTION_TOO_EXAGGERATED' });
  job = transitionJob(job, JOB_STATES.RETRY);
  job = transitionJob(job, JOB_STATES.ROUTING);
  assert.equal(job.jobId, 'JOB-001');
  assert.equal(job.status, JOB_STATES.ROUTING);
});

test('enforces quota AVAILABLE → RESERVED → COMMITTED', () => {
  let quota = { state: QUOTA_STATES.AVAILABLE };
  quota = settleQuota(quota, QUOTA_EVENTS.RESERVE);
  quota = settleQuota(quota, QUOTA_EVENTS.COMMIT, { reason: 'VALIDATION_PASS' });
  assert.equal(quota.state, QUOTA_STATES.COMMITTED);
  assert.equal(quota.finalSettlement, QUOTA_EVENTS.COMMIT);
  assert.throws(() => settleQuota(quota, QUOTA_EVENTS.RELEASE), /Invalid quota settlement/);
});

test('enforces quota AVAILABLE → RESERVED → RELEASED', () => {
  let quota = { state: QUOTA_STATES.AVAILABLE };
  quota = settleQuota(quota, QUOTA_EVENTS.RESERVE);
  quota = settleQuota(quota, QUOTA_EVENTS.RELEASE, { reason: 'PROVIDER_FAILURE' });
  assert.equal(quota.state, QUOTA_STATES.RELEASED);
  assert.equal(quota.finalSettlement, QUOTA_EVENTS.RELEASE);
  assert.throws(() => settleQuota(quota, QUOTA_EVENTS.COMMIT), /Invalid quota settlement/);
});

test('prevents double final settlement in a logical generation', () => {
  assert.equal(assertSingleFinalSettlement([QUOTA_EVENTS.RESERVE]), null);
  assert.equal(assertSingleFinalSettlement([QUOTA_EVENTS.RESERVE, QUOTA_EVENTS.COMMIT]), QUOTA_EVENTS.COMMIT);
  assert.throws(
    () => assertSingleFinalSettlement([QUOTA_EVENTS.RESERVE, QUOTA_EVENTS.COMMIT, QUOTA_EVENTS.RELEASE]),
    /only one final quota settlement/,
  );
});

test('normalizes safe idempotency keys', () => {
  assert.equal(normalizeIdempotencyKey('  request-001:v1  '), 'request-001:v1');
  const record = idempotencyRecord({ key: 'request-001', jobId: 'JOB-001', requestHash: 'abc' });
  assert.deepEqual({ key: record.key, jobId: record.jobId, requestHash: record.requestHash, status: record.status }, {
    key: 'request-001',
    jobId: 'JOB-001',
    requestHash: 'abc',
    status: 'ACTIVE',
  });
});

test('rejects missing, malformed, and oversized idempotency keys', () => {
  assert.throws(() => normalizeIdempotencyKey(''), /required/);
  assert.throws(() => normalizeIdempotencyKey('bad key'), /invalid characters/);
  assert.throws(() => normalizeIdempotencyKey('x'.repeat(201)), /too long/);
});

test('expires durable jobs after the configured timeout', () => {
  const createdAt = '2026-10-03T00:00:00.000Z';
  const now = Date.parse('2026-10-03T00:06:00.000Z');
  assert.equal(GENERATION_POLICY.timeoutSeconds, 360);
  assert.equal(elapsedSeconds(createdAt, now), 360);
  assert.equal(shouldExpireGeneration(createdAt, now), true);
  assert.equal(shouldExpireGeneration(createdAt, now - 1000), false);
});

test('allows one controlled provider retry only for retryable failures', () => {
  assert.deepEqual(retryDecision({ failureCode: 'MEDIA_ERROR', attemptNo: 1 }), {
    retryable: true, allowed: true, nextAttemptNo: 2, reason: 'policy-eligible',
  });
  assert.equal(retryDecision({ failureCode: 'MEDIA_ERROR', attemptNo: 2 }).allowed, false);
  assert.equal(retryDecision({ failureCode: 'USER_CANCELLED', attemptNo: 1 }).allowed, false);
});
