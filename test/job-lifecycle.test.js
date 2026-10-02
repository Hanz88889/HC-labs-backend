import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_STATES,
  QUOTA_EVENTS,
  QUOTA_STATES,
  assertSingleFinalSettlement,
  canTransitionJob,
  idempotencyRecord,
  normalizeIdempotencyKey,
  settleQuota,
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
