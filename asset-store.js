const MAX_ASSET_BYTES = 250 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

async function readCapped(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => null);
      throw new Error('ASSET_TOO_LARGE');
    }
    chunks.push(part.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function expectedTypeForFlow(flow) {
  return flow === 't2i' || flow === 'i2i' ? 'image' : 'video';
}

function extensionFor(contentType, expectedType) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('webm')) return 'webm';
  return expectedType === 'image' ? 'bin' : 'mp4';
}

export async function persistGeneratedAsset(env, { flow, jobId, attemptId, sourceUrl }) {
  if (!env.HC_ASSETS) return { ok: false, reason: 'R2_UNAVAILABLE' };
  let response;
  try { response = await fetch(sourceUrl); } catch { return { ok: false, reason: 'SOURCE_FETCH_FAILED' }; }
  if (!response.ok || !response.body) return { ok: false, reason: 'SOURCE_FETCH_FAILED', status: response.status };

  const expectedType = expectedTypeForFlow(flow);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith(`${expectedType}/`)) {
    return { ok: false, reason: 'SOURCE_MEDIA_TYPE_MISMATCH', contentType };
  }

  const advertisedBytes = Number(response.headers.get('content-length') || 0);
  if (advertisedBytes > MAX_ASSET_BYTES) return { ok: false, reason: 'SOURCE_ASSET_TOO_LARGE' };

  const key = `generated/${jobId}/${attemptId}.${extensionFor(contentType, expectedType)}`;
  const putOptions = {
    httpMetadata: { contentType, cacheControl: 'public, max-age=86400' },
    customMetadata: { job_id: jobId, attempt_id: attemptId, flow },
  };
  let bytes = 0;
  try {
    if (advertisedBytes > 0) {
      await env.HC_ASSETS.put(key, response.body, putOptions);
      bytes = advertisedBytes;
    } else {
      const data = await readCapped(response.body, MAX_BUFFERED_BYTES);
      await env.HC_ASSETS.put(key, data, putOptions);
      bytes = data.byteLength;
    }
  } catch (error) {
    return { ok: false, reason: error.message === 'ASSET_TOO_LARGE' ? 'SOURCE_ASSET_TOO_LARGE' : 'R2_PUT_FAILED' };
  }

  return {
    ok: true,
    key,
    contentType,
    bytes,
    internalUrl: `/api/assets/${encodeURIComponent(key)}`,
  };
}

export async function getStoredAsset(env, key) {
  if (!env.HC_ASSETS || !key || key.includes('..') || !key.startsWith('generated/')) return null;
  return env.HC_ASSETS.get(key);
}
