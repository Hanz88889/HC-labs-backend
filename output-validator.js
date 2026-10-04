const URL_PROTOCOLS = new Set(['http:', 'https:']);

export function validateOutputContract({ flow, url, providerData = {}, prompt = '', durationSeconds = null }) {
  const failures = [];
  const expectedKind = flow === 't2i' || flow === 'i2i' ? 'image' : 'video';

  try {
    const parsed = new URL(url);
    if (!URL_PROTOCOLS.has(parsed.protocol)) failures.push('OUTPUT_URL_PROTOCOL_UNSUPPORTED');
  } catch {
    failures.push('OUTPUT_URL_INVALID');
  }

  if (typeof prompt !== 'string' || prompt.trim().length < 2) failures.push('PROMPT_CONTENT_EMPTY');
  if (providerData?.error || providerData?.failed === true) failures.push('PROVIDER_CONTENT_FAILURE');
  if (providerData?.safety?.blocked === true || providerData?.content_policy?.blocked === true) {
    failures.push('CONTENT_POLICY_BLOCKED');
  }

  const declaredKind = providerData?.media_type || providerData?.content_type;
  if (declaredKind && !String(declaredKind).toLowerCase().includes(expectedKind)) {
    failures.push('OUTPUT_MEDIA_TYPE_MISMATCH');
  }

  if (expectedKind === 'video' && durationSeconds != null) {
    const actualDuration = Number(providerData?.duration ?? providerData?.duration_seconds);
    if (Number.isFinite(actualDuration) && Math.abs(actualDuration - Number(durationSeconds)) > 1.5) {
      failures.push('OUTPUT_DURATION_MISMATCH');
    }
  }

  return {
    status: failures.length ? 'FAIL' : 'PASS',
    validationType: 'content',
    failureCode: failures[0] || null,
    details: { expectedKind, checks: ['url', 'prompt', 'provider_status', 'content_policy', 'media_type', 'duration'], failures },
  };
}

export function validateStoredAsset({ contentType, expectedKind, bytes }) {
  const normalized = String(contentType || '').toLowerCase();
  const failures = [];
  if (!normalized.startsWith(`${expectedKind}/`)) failures.push('STORED_MEDIA_TYPE_MISMATCH');
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) failures.push('STORED_ASSET_EMPTY');
  return {
    status: failures.length ? 'FAIL' : 'PASS',
    validationType: 'technical',
    failureCode: failures[0] || null,
    details: { contentType: normalized, bytes: Number(bytes) || 0, failures },
  };
}
