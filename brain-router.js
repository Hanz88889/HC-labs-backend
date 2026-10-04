import { callBrainProvider } from './llm-router.js';
import { normalizeContentPlanV1 } from './task-spec.js';
import { buildContentBlueprint } from './content-blueprint.js';
import { compilePrompt } from './prompt-compiler.js';
import { routeTaskSpec } from './capability-registry.js';

const PLAN_SCHEMA = 'hclabs.content-plan.v1';
const SESSION_TTL = 60 * 60 * 24 * 30;

const SYSTEM_PROMPT = `You are the provider-independent Conversation Brain of HC Labs.
Transform the user's creative brief into a production-ready content plan for an image, video, or image-edit generation engine.
Return ONLY valid JSON. Do not wrap it in markdown fences and do not add commentary.
Use exactly this shape:
{
  "schema": "hclabs.content-plan.v1",
  "goal": "image|video|edit",
  "format": "string",
  "tone": "string",
  "creative_direction": "string",
  "generation_prompt": "string",
  "duration_seconds": 15,
  "generation": { "mode": "text-to-image|text-to-video|image-to-image", "aspect_ratio": "1:1|16:9|9:16|4:5", "camera_motion": "string" },
  "scenes": [{ "id": 1, "objective": "string", "visual": "string", "camera": "string", "lighting": "string", "motion": "string", "duration": 5, "prompt": "string" }]
}
For image or edit goals, scenes may be an empty array and duration_seconds may be null. For video, use three coherent scenes totaling 15 seconds. Keep every required key present.`;

function stripJsonFences(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

export function validatePlan(plan, input) {
  if (!plan || typeof plan !== 'object') throw new Error('LLM plan bukan object JSON');
  if (plan.schema !== PLAN_SCHEMA) throw new Error(`Schema plan tidak valid; expected ${PLAN_SCHEMA}`);
  if (!['image', 'video', 'edit'].includes(plan.goal)) throw new Error('Plan goal tidak valid');
  if (!plan.generation_prompt || typeof plan.generation_prompt !== 'string') throw new Error('Plan tidak memiliki generation_prompt');
  if (!plan.generation || typeof plan.generation !== 'object') throw new Error('Plan tidak memiliki generation config');
  const modes = { image: 'text-to-image', video: 'text-to-video', edit: 'image-to-image' };
  if (plan.generation.mode !== modes[plan.goal]) throw new Error('Generation mode tidak sesuai goal');
  if (!['1:1', '16:9', '9:16', '4:5'].includes(plan.generation.aspect_ratio)) throw new Error('Aspect ratio tidak valid');
  if (!Array.isArray(plan.scenes)) throw new Error('Plan scenes harus array');
  if (plan.goal === 'video') {
    if (plan.scenes.length !== 3) throw new Error('Plan video harus memiliki tepat tiga scene');
    const totalDuration = plan.scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
    if (totalDuration !== 15) throw new Error('Total durasi scene video harus 15 detik');
  } else if (plan.scenes.length !== 0) {
    throw new Error('Plan image/edit tidak boleh memiliki scene');
  }
  return { ...plan, conversation_id: input.conversation_id };
}

function normalizeConversationId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{3,80}$/.test(id) ? id : `conv-${crypto.randomUUID().slice(0, 8)}`;
}

export async function handleBrainRefine(request, env, license) {
  let body;
  try { body = await request.json(); } catch { return { error: 'Body JSON tidak valid', status: 400 }; }
  const { input, goal = 'image', tone = 'Premium & warm', format = 'Social-ready' } = body;
  if (!input || typeof input !== 'string') return { error: 'input wajib diisi', status: 400 };
  if (input.length > 8000) return { error: 'input terlalu panjang (maksimal 8.000 karakter)', status: 413 };
  if (!['image', 'video', 'edit'].includes(goal)) return { error: 'goal tidak valid', status: 400 };

  const conversationId = normalizeConversationId(body.conversation_id);
  const sessionKey = `brain:${license.key}:${conversationId}`;
  let previous = null;
  if (env.hc_kv) {
    const raw = await env.hc_kv.get(sessionKey);
    if (raw) { try { previous = JSON.parse(raw); } catch {} }
  }

  const llm = await callBrainProvider({
    model: undefined,
    systemPrompt: SYSTEM_PROMPT,
    input: { conversation_id: conversationId, previous_context: previous?.context || [], input, goal, tone, format },
  }, env);

  let plan;
  try { plan = JSON.parse(stripJsonFences(llm.content)); }
  catch { throw new Error('Response layanan bahasa bukan JSON valid'); }
  plan = validatePlan(plan, { conversation_id: conversationId });
  const taskSpec = normalizeContentPlanV1(plan);
  const contentBlueprint = buildContentBlueprint(taskSpec, plan.workflow || null);
  const compiledPrompt = compilePrompt(taskSpec, contentBlueprint);
  const routing = routeTaskSpec(taskSpec);

  if (env.hc_kv) {
    const context = [...(previous?.context || []), { input, goal, tone, format, plan }].slice(-8);
    await env.hc_kv.put(sessionKey, JSON.stringify({ conversation_id: conversationId, context }), { expirationTtl: SESSION_TTL });
  }

  return {
    ok: true,
    conversation_id: conversationId,
    model: 'configured-model',
    plan,
    task_spec: taskSpec,
    content_blueprint: contentBlueprint,
    compiled_prompt: compiledPrompt,
    routing,
    usage: llm.usage,
    provider: 'llm-router',
  };
}
