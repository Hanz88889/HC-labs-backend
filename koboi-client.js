const KOBOLLM_TIMEOUT_MS = 30_000;
export const DEFAULT_KOBOI_BASE_URL = 'https://lite.koboillm.com/v1';
const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_INPUT_CHARS = 12_000;

export const DEFAULT_KOBOI_MODEL = 'openai/gpt-6-astra';

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function koboiConfig(env) {
  return {
    baseUrl: normalizeBaseUrl(env.KOBOLLM_BASE_URL || env.KOBOI_BASE_URL || DEFAULT_KOBOI_BASE_URL),
    apiKey: env.KOBOLLM_API_KEY || env.KOBOI_API_KEY,
    model: env.KOBOLLM_MODEL || env.KOBOI_MODEL || DEFAULT_KOBOI_MODEL,
  };
}

export async function callKoboiBrain({ model, systemPrompt, input }, env) {
  const config = koboiConfig(env);
  if (!config.baseUrl) throw new Error('Konfigurasi layanan bahasa belum lengkap');
  if (!config.apiKey) throw new Error('Kredensial layanan bahasa belum tersedia');
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error('System prompt tidak valid atau terlalu besar');
  }
  const serializedInput = JSON.stringify(input);
  if (serializedInput.length > MAX_INPUT_CHARS) throw new Error('Input Conversation Brain terlalu besar');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KOBOLLM_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: serializedInput },
        ],
        temperature: 0.4,
        max_tokens: 3000,
        stream: false,
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Layanan bahasa timeout setelah 30 detik');
    throw new Error('Layanan bahasa tidak dapat dihubungi');
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Layanan bahasa mengembalikan response tidak valid (HTTP ${response.status})`); }
  if (!response.ok) {
    const detail = data.error?.message || data.detail || data.message || `HTTP ${response.status}`;
    throw new Error(`Layanan bahasa menolak permintaan (HTTP ${response.status})`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Response layanan bahasa tidak berisi konten');
  return { content, model: data.model || model || config.model, usage: data.usage || null };
}
