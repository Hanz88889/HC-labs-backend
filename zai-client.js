const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const ZAI_TIMEOUT_MS = 30_000;
const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_INPUT_CHARS = 12_000;
export const DEFAULT_BRAIN_MODEL = 'glm-5.3-flash';

export async function callZaiBrain({ model, systemPrompt, input }, env) {
  if (!env.ZAI_API_KEY) throw new Error('Kredensial layanan bahasa belum tersedia');
  model = model || DEFAULT_BRAIN_MODEL;

  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error('System prompt tidak valid atau terlalu besar');
  }
  const serializedInput = JSON.stringify(input);
  if (serializedInput.length > MAX_INPUT_CHARS) {
    throw new Error('Input Conversation Brain terlalu besar');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZAI_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ZAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.ZAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify({
        model,
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
  return { content, model: data.model || model, usage: data.usage || null };
}

export { ZAI_URL };
