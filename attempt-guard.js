export const ATTEMPT_LIMITS = {
  windowSeconds: 900,
  lockSeconds: 900,
  perIp: 10,
  perLicense: 5,
  warnAtRemaining: 2,
};

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function dbReady(env) {
  return Boolean(env && env.HC_DB && typeof env.HC_DB.prepare === 'function');
}

export function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
}

function licenseScope(licenseKey) {
  return `lic:${String(licenseKey).slice(0, 200)}`;
}

export async function checkAttemptBlock(env, request, licenseKey) {
  if (!dbReady(env)) return { blocked: false, retryAfterSeconds: 0 };
  try {
    const scopes = [`ip:${clientIp(request)}`];
    if (licenseKey) scopes.push(licenseScope(licenseKey));
    const now = nowEpoch();
    const row = await env.HC_DB.prepare(`
      SELECT MAX(locked_until_epoch) AS locked_until FROM auth_attempts
      WHERE scope_key IN (?1, ?2) AND locked_until_epoch > ?3
    `).bind(scopes[0], scopes[1] || scopes[0], now).first();
    const lockedUntil = Number(row?.locked_until || 0);
    if (lockedUntil > now) return { blocked: true, retryAfterSeconds: lockedUntil - now };
    return { blocked: false, retryAfterSeconds: 0 };
  } catch {
    return { blocked: false, retryAfterSeconds: 0 };
  }
}

async function bumpScope(env, scope, limit) {
  const now = nowEpoch();
  const row = await env.HC_DB.prepare(`
    INSERT INTO auth_attempts (scope_key, failures, window_start_epoch, locked_until_epoch)
    VALUES (?1, 1, ?2, CASE WHEN 1 >= ?4 THEN ?2 + ?5 ELSE 0 END)
    ON CONFLICT(scope_key) DO UPDATE SET
      failures = CASE WHEN auth_attempts.window_start_epoch + ?3 <= ?2
                      THEN 1 ELSE auth_attempts.failures + 1 END,
      locked_until_epoch = CASE
        WHEN (CASE WHEN auth_attempts.window_start_epoch + ?3 <= ?2
                   THEN 1 ELSE auth_attempts.failures + 1 END) >= ?4
        THEN ?2 + ?5 ELSE auth_attempts.locked_until_epoch END,
      window_start_epoch = CASE WHEN auth_attempts.window_start_epoch + ?3 <= ?2
                                THEN ?2 ELSE auth_attempts.window_start_epoch END
    RETURNING failures, locked_until_epoch
  `).bind(scope, now, ATTEMPT_LIMITS.windowSeconds, limit, ATTEMPT_LIMITS.lockSeconds).first();
  const failures = Number(row?.failures || 0);
  return {
    remaining: Math.max(0, limit - failures),
    blocked: Number(row?.locked_until_epoch || 0) > now,
  };
}

export async function recordFailedAttempt(env, request, licenseKey, options = {}) {
  if (!dbReady(env)) return { blocked: false, remaining: null };
  try {
    const ip = await bumpScope(env, `ip:${clientIp(request)}`, ATTEMPT_LIMITS.perIp);
    let blocked = ip.blocked;
    let remaining = ip.remaining;
    if (options.licenseKnown && licenseKey) {
      const lic = await bumpScope(env, licenseScope(licenseKey), ATTEMPT_LIMITS.perLicense);
      blocked = blocked || lic.blocked;
      remaining = Math.min(remaining, lic.remaining);
    }
    return { blocked, remaining };
  } catch {
    return { blocked: false, remaining: null };
  }
}

export async function pruneAuthAttempts(env) {
  if (!dbReady(env)) return;
  await env.HC_DB.prepare(
    'DELETE FROM auth_attempts WHERE locked_until_epoch <= ?1 AND window_start_epoch + 86400 <= ?1',
  ).bind(nowEpoch()).run().catch(() => null);
}

export function blockedMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil((Number(retryAfterSeconds) || ATTEMPT_LIMITS.lockSeconds) / 60));
  return `Terlalu banyak percobaan gagal. Akses dikunci ${minutes} menit. Hubungi Admin Quorvante jika butuh bantuan.`;
}

export function warningMessage(remaining) {
  return `Sisa percobaan: ${remaining}. Periksa kembali kode dan email Anda, atau hubungi Admin Quorvante.`;
}
