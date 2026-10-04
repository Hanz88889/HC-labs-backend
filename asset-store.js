const MAX_ASSET_BYTES = 250 * 1024 * 1024;

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

  const key = `assets/${jobId}/${attemptId}.${extensionFor(contentType, expectedType)}`;
  const { readable, writable } = new TransformStream();
  const reader = response.body.getReader();
  const writer = writable.getWriter();
  let bytes = 0;
  const pump = (async () => {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_ASSET_BYTES) throw new Error('ASSET_TOO_LARGE');
        await writer.write(part.value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error);
      throw error;
    }
  })();

  try {
    const upload = env.HC_ASSETS.put(key, readable, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { job_id: jobId, attempt_id: attemptId, flow },
    });
    await pump;
    await upload;
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
  if (!env.HC_ASSETS || !key || key.includes('..')) return null;
  return env.HC_ASSETS.get(key);
}
