export const JOB_STATES = Object.freeze({
  CREATED: 'CREATED',
  VALIDATING_REQUEST: 'VALIDATING_REQUEST',
  RESERVED: 'RESERVED',
  PLANNED: 'PLANNED',
  ROUTING: 'ROUTING',
  SUBMITTING: 'SUBMITTING',
  SUBMITTED: 'SUBMITTED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  DOWNLOADING: 'DOWNLOADING',
  VALIDATING_OUTPUT: 'VALIDATING_OUTPUT',
  CONTENT_VALIDATION: 'CONTENT_VALIDATION',
  REFINING: 'REFINING',
  RETRY: 'RETRY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

export const QUOTA_STATES = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
});

export const QUOTA_EVENTS = Object.freeze({
  RESERVE: 'RESERVE',
  COMMIT: 'COMMIT',
  RELEASE: 'RELEASE',
});

export const GENERATION_POLICY = Object.freeze({
  timeoutSeconds: 360,
  maxAutomaticRefinementRetries: 1,
  maxProviderAttempts: 2,
  maxActiveJobsPerLicense: 2,
});

const RETRYABLE_FAILURE_CODES = new Set([
  'MEDIA_ERROR', 'MEDIA_SUBMIT_FAILED', 'NO_RESULT', 'TIMEOUT',
  'TECHNICAL_VALIDATION_FAILED', 'KNOWN_QUALITY_FAILURE',
]);

export function elapsedSeconds(createdAt, now = Date.now()) {
  const created = Date.parse(createdAt || '');
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now - created) / 1000));
}

export function shouldExpireGeneration(createdAt, now = Date.now(), timeoutSeconds = GENERATION_POLICY.timeoutSeconds) {
  return elapsedSeconds(createdAt, now) >= timeoutSeconds;
}

export function retryDecision({ failureCode, attemptNo = 1, maxAttempts = GENERATION_POLICY.maxProviderAttempts }) {
  const normalizedAttempt = Number(attemptNo) || 1;
  const retryable = RETRYABLE_FAILURE_CODES.has(String(failureCode || '').toUpperCase());
  return {
    retryable,
    allowed: retryable && normalizedAttempt < maxAttempts,
    nextAttemptNo: normalizedAttempt + 1,
    reason: retryable ? 'policy-eligible' : 'non-retryable-failure',
  };
}

const TERMINAL_JOB_STATES = new Set([
  JOB_STATES.COMPLETED,
  JOB_STATES.FAILED,
  JOB_STATES.CANCELLED,
  JOB_STATES.EXPIRED,
]);

const TRANSITIONS = Object.freeze({
  [JOB_STATES.CREATED]: new Set([JOB_STATES.VALIDATING_REQUEST, JOB_STATES.CANCELLED]),
  [JOB_STATES.VALIDATING_REQUEST]: new Set([JOB_STATES.RESERVED, JOB_STATES.FAILED, JOB_STATES.CANCELLED]),
  [JOB_STATES.RESERVED]: new Set([JOB_STATES.PLANNED, JOB_STATES.SUBMITTING, JOB_STATES.CANCELLED, JOB_STATES.EXPIRED]),
  [JOB_STATES.PLANNED]: new Set([JOB_STATES.ROUTING, JOB_STATES.SUBMITTING, JOB_STATES.FAILED, JOB_STATES.CANCELLED]),
  [JOB_STATES.ROUTING]: new Set([JOB_STATES.SUBMITTING, JOB_STATES.FAILED, JOB_STATES.CANCELLED]),
  [JOB_STATES.SUBMITTING]: new Set([JOB_STATES.SUBMITTED, JOB_STATES.FAILED]),
  [JOB_STATES.SUBMITTED]: new Set([JOB_STATES.QUEUED, JOB_STATES.PROCESSING, JOB_STATES.FAILED, JOB_STATES.EXPIRED]),
  [JOB_STATES.QUEUED]: new Set([JOB_STATES.PROCESSING, JOB_STATES.FAILED, JOB_STATES.EXPIRED]),
  [JOB_STATES.PROCESSING]: new Set([JOB_STATES.DOWNLOADING, JOB_STATES.FAILED, JOB_STATES.EXPIRED, JOB_STATES.CANCELLED]),
  [JOB_STATES.DOWNLOADING]: new Set([JOB_STATES.VALIDATING_OUTPUT, JOB_STATES.FAILED]),
  [JOB_STATES.VALIDATING_OUTPUT]: new Set([JOB_STATES.CONTENT_VALIDATION, JOB_STATES.COMPLETED, JOB_STATES.REFINING, JOB_STATES.FAILED]),
  [JOB_STATES.CONTENT_VALIDATION]: new Set([JOB_STATES.COMPLETED, JOB_STATES.REFINING, JOB_STATES.FAILED]),
  [JOB_STATES.REFINING]: new Set([JOB_STATES.RETRY, JOB_STATES.FAILED]),
  [JOB_STATES.RETRY]: new Set([JOB_STATES.ROUTING, JOB_STATES.SUBMITTING, JOB_STATES.PROCESSING, JOB_STATES.FAILED]),
  [JOB_STATES.COMPLETED]: new Set(),
  [JOB_STATES.FAILED]: new Set(),
  [JOB_STATES.CANCELLED]: new Set(),
  [JOB_STATES.EXPIRED]: new Set(),
});

function assertKnownJobState(state) {
  if (!Object.values(JOB_STATES).includes(state)) {
    throw new Error(`Unknown job state: ${state}`);
  }
}

function assertKnownQuotaState(state) {
  if (!Object.values(QUOTA_STATES).includes(state)) {
    throw new Error(`Unknown quota state: ${state}`);
  }
}

export function canTransitionJob(from, to) {
  assertKnownJobState(from);
  assertKnownJobState(to);
  return TRANSITIONS[from].has(to);
}

export function transitionJob(job, to, metadata = {}) {
  const current = job?.status;
  assertKnownJobState(current);
  if (!canTransitionJob(current, to)) {
    throw new Error(`Invalid job transition: ${current} -> ${to}`);
  }
  return {
    ...job,
    status: to,
    statusChangedAt: metadata.statusChangedAt || new Date().toISOString(),
    ...(metadata.reason ? { statusReason: metadata.reason } : {}),
  };
}

export function isTerminalJobState(state) {
  assertKnownJobState(state);
  return TERMINAL_JOB_STATES.has(state);
}

export function canSettleQuota(state, event) {
  assertKnownQuotaState(state);
  if (event === QUOTA_EVENTS.COMMIT || event === QUOTA_EVENTS.RELEASE) {
    return state === QUOTA_STATES.RESERVED;
  }
  if (event === QUOTA_EVENTS.RESERVE) {
    return state === QUOTA_STATES.AVAILABLE;
  }
  throw new Error(`Unknown quota event: ${event}`);
}

export function settleQuota(quota, event, metadata = {}) {
  const current = quota?.state;
  assertKnownQuotaState(current);
  if (!canSettleQuota(current, event)) {
    throw new Error(`Invalid quota settlement: ${current} + ${event}`);
  }

  const nextState = {
    [QUOTA_EVENTS.RESERVE]: QUOTA_STATES.RESERVED,
    [QUOTA_EVENTS.COMMIT]: QUOTA_STATES.COMMITTED,
    [QUOTA_EVENTS.RELEASE]: QUOTA_STATES.RELEASED,
  }[event];

  return {
    ...quota,
    state: nextState,
    finalSettlement: event === QUOTA_EVENTS.COMMIT || event === QUOTA_EVENTS.RELEASE
      ? event
      : quota.finalSettlement || null,
    settledAt: event === QUOTA_EVENTS.COMMIT || event === QUOTA_EVENTS.RELEASE
      ? metadata.settledAt || new Date().toISOString()
      : quota.settledAt || null,
    settlementReason: metadata.reason || quota.settlementReason || null,
  };
}

export function assertSingleFinalSettlement(events = []) {
  const finals = events.filter((event) =>
    event === QUOTA_EVENTS.COMMIT || event === QUOTA_EVENTS.RELEASE,
  );
  if (finals.length > 1) {
    throw new Error('A logical generation may have only one final quota settlement');
  }
  if (finals.length === 1 && finals[0] !== QUOTA_EVENTS.COMMIT && finals[0] !== QUOTA_EVENTS.RELEASE) {
    throw new Error('Invalid final quota settlement');
  }
  return finals[0] || null;
}

export function normalizeIdempotencyKey(value) {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('Idempotency-Key is required');
  if (key.length > 200) throw new Error('Idempotency-Key is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new Error('Idempotency-Key contains invalid characters');
  }
  return key;
}

export function idempotencyRecord({ key, jobId, requestHash, status = 'ACTIVE' }) {
  return {
    key: normalizeIdempotencyKey(key),
    jobId,
    requestHash: requestHash || null,
    status,
    createdAt: new Date().toISOString(),
  };
}
