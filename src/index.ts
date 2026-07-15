/**
 * FitConnect meal-parsing Worker.
 *
 * The mobile app sends a free-text meal description; this Worker asks Anthropic's
 * Messages API to turn it into structured food items and returns them as JSON.
 * The Anthropic API key lives only as a Worker secret (env.ANTHROPIC_API_KEY) —
 * it never ships in the app.
 *
 *   POST /parse-meal
 *     body:  { text: string, locale: 'en' | 'ka' }
 *     200:   { items: [{ name, kcal, proteinG, carbsG, fatG }] }
 *     400:   invalid body / empty text / text too long   -> { error }
 *     429:   per-IP rate limit, or Anthropic upstream 429 (passthrough)
 *     502:   upstream AI failure (network, bad status, or unparseable output)
 */

interface Env {
  ANTHROPIC_API_KEY: string;
}

interface FoodItem {
  name: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

type Locale = 'en' | 'ka';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Current cheapest/fastest Haiku tier. Supports `temperature`.
const MODEL = 'claude-haiku-4-5';
const MAX_TEXT_LEN = 500;
const MAX_ITEMS = 10;

// --- Per-IP rate limit (abuse guard) ----------------------------------------
// Best-effort: ~20 requests / 60s per IP.
// LIMITATION: this Map lives in a single Worker isolate's memory. Cloudflare runs
// many isolates across many locations, so this is NOT a true global limit — a
// client can exceed it by landing on different isolates. It's a cheap, free-tier
// friendly speed bump. For real limits use a Durable Object, KV, or Cloudflare's
// Rate Limiting binding.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent); // keep the pruned list so memory doesn't grow unbounded
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// --- CORS + response helpers -------------------------------------------------
// Allow all origins for now (mobile app). Tighten to specific origins for production.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonError(status: number, error: string): Response {
  return json(status, { error });
}

// --- System prompt -----------------------------------------------------------
const SYSTEM_PROMPT = `You are a nutrition estimator for a fitness app. The user sends a casual, free-text meal description. It may be in English or Georgian (ქართული).

Handle Georgian dishes natively, with realistic single-portion nutrition — e.g. ხაჭაპური (khachapuri), ხინკალი (khinkali, estimate per piece), ლობიანი (lobiani), მწვადი (mtsvadi), ჩახოხბილი (chakhokhbili), ბადრიჯანი ნიგვზით (badrijani nigvzit).

Rules:
- Output STRICT JSON ONLY, exactly this shape: {"items":[{"name":string,"kcal":integer,"proteinG":integer,"carbsG":integer,"fatG":integer}]}
- No prose, no explanations, no markdown code fences — just the JSON object.
- One item per distinct food or drink mentioned.
- If a quantity is not given, estimate one reasonable single portion.
- Return each item's "name" in the SAME LANGUAGE as the input text (the locale field is only a hint).
- kcal is an integer (calories). proteinG, carbsG, fatG are integers, in grams.
- All numbers must be >= 0.
- If the input is not food/drink or is unrecognizable, return {"items":[]}.`;

// --- Anthropic call ----------------------------------------------------------
type AiOutcome = { ok: true; text: string } | { ok: false; status: number };

async function callAnthropic(env: Env, text: string, locale: Locale): Promise<AiOutcome> {
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Locale hint: ${locale}\nMeal description:\n${text}`,
          },
        ],
      }),
    });
  } catch (err) {
    // Network / fetch error reaching Anthropic. Log server-side only.
    console.error('anthropic: network error reaching API', err);
    return { ok: false, status: 502 };
  }

  // Pass upstream rate limiting straight through to the client.
  if (res.status === 429) return { ok: false, status: 429 };
  if (!res.ok) {
    // Log the real upstream error server-side; never leak it to the client.
    console.error('anthropic: upstream error', res.status, (await res.text()).slice(0, 500));
    return { ok: false, status: 502 };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    console.error('anthropic: could not parse response JSON', err);
    return { ok: false, status: 502 };
  }

  const modelText = extractText(data);
  if (modelText === null) {
    console.error('anthropic: no text block in response', JSON.stringify(data).slice(0, 500));
    return { ok: false, status: 502 };
  }
  return { ok: true, text: modelText };
}

// Pull the first text block out of an Anthropic Messages response.
function extractText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

// --- Defensive parsing of the model's JSON -----------------------------------
function stripFences(s: string): string {
  const trimmed = s.trim();
  // Remove a leading ```json / ``` fence and trailing ``` if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1]! : trimmed).trim();
}

function clampInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0; // clamp NaN/negatives to 0
  return Math.round(n);
}

// Returns validated items, or null if the payload is unusable (-> 502).
function parseItems(raw: string): FoodItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const out: FoodItem[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    out.push({
      name: typeof r.name === 'string' ? r.name : String(r.name ?? ''),
      kcal: clampInt(r.kcal),
      proteinG: clampInt(r.proteinG),
      carbsG: clampInt(r.carbsG),
      fatG: clampInt(r.fatG),
    });
  }
  return out;
}

// --- /parse-meal handler -----------------------------------------------------
async function handleParseMeal(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid_body');
  }
  if (typeof body !== 'object' || body === null) {
    return jsonError(400, 'invalid_body');
  }

  const rawText = (body as { text?: unknown }).text;
  if (typeof rawText !== 'string') {
    return jsonError(400, 'invalid_body');
  }
  if (rawText.trim().length === 0) {
    return jsonError(400, 'empty_text');
  }
  if (rawText.length > MAX_TEXT_LEN) {
    return jsonError(400, 'text_too_long');
  }
  const text = rawText.trim();

  const rawLocale = (body as { locale?: unknown }).locale;
  const locale: Locale = rawLocale === 'ka' ? 'ka' : 'en'; // hint only; default 'en'

  const ai = await callAnthropic(env, text, locale);
  if (!ai.ok) {
    return jsonError(ai.status, ai.status === 429 ? 'rate_limited' : 'upstream_error');
  }

  const items = parseItems(ai.text);
  if (items === null) {
    return jsonError(502, 'upstream_error');
  }

  return json(200, { items });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/parse-meal') {
      return jsonError(404, 'not_found');
    }
    if (request.method !== 'POST') {
      return jsonError(405, 'method_not_allowed');
    }

    // Per-IP abuse guard.
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (isRateLimited(ip)) {
      return jsonError(429, 'rate_limited');
    }

    return handleParseMeal(request, env);
  },
} satisfies ExportedHandler<Env>;
