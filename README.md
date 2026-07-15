# FitConnect meal-parsing Worker

A thin [Cloudflare Worker](https://developers.cloudflare.com/workers/) that turns free-text meal
descriptions (English or Georgian) into structured food items with calories and macros, by calling
Anthropic's Messages API.

The mobile app POSTs a meal description; the Worker calls Anthropic (using
[`claude-haiku-4-5`](https://docs.anthropic.com/), the cheapest/fastest tier) and returns JSON. The
**Anthropic API key lives only as a Worker secret — it never ships in the app.**

## Endpoint

```
POST /parse-meal
Content-Type: application/json

{ "text": "two eggs and toast", "locale": "en" }   // locale: "en" | "ka" (a hint)
```

**200 OK**

```json
{
  "items": [
    { "name": "Scrambled eggs", "kcal": 180, "proteinG": 12, "carbsG": 2, "fatG": 13 },
    { "name": "Toast with butter", "kcal": 120, "proteinG": 3, "carbsG": 15, "fatG": 5 }
  ]
}
```

**Errors** — all use the shape `{ "error": "<code>" }`:

| Status | When |
| ------ | ---- |
| `400`  | Invalid JSON body, missing/empty `text`, or `text` longer than 500 chars |
| `429`  | Per-IP rate limit hit (~20 req/min), or Anthropic itself is rate-limiting (passthrough) |
| `502`  | Upstream AI failure — network error, bad response, or output that couldn't be parsed |
| `404` / `405` | Unknown path / wrong method |

Unrecognizable or non-food input returns `200` with `{ "items": [] }`.

---

## One-time account setup

You only need to do these once.

1. **Create a Cloudflare account** (free) and log in from this machine:

   ```sh
   npx wrangler login
   ```

   This opens a browser to authorize deploys.

2. **Get an Anthropic API key** from the [Anthropic Console](https://console.anthropic.com) →
   *API Keys*. (You'll need a little credit/billing set up on the account.)

3. **Store the key as a Worker secret** (used in production):

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   # paste your sk-ant-... key when prompted
   ```

   Cloudflare encrypts it and exposes it to the Worker as `env.ANTHROPIC_API_KEY`. It never
   appears in the code or the app.

4. **For local development**, put the key in `.dev.vars` (already scaffolded, and gitignored):

   ```
   ANTHROPIC_API_KEY=sk-ant-your-real-key
   ```

---

## Develop locally

```sh
npm install
npm run dev        # serves on http://localhost:8787
```

### Try it (curl)

**English meal:**

```sh
curl -s http://localhost:8787/parse-meal \
  -H 'Content-Type: application/json' \
  -d '{"text":"two scrambled eggs and a slice of toast with butter","locale":"en"}'
```

**Georgian meal (ერთი ხაჭაპური და ორი ხინკალი):**

```sh
curl -s http://localhost:8787/parse-meal \
  -H 'Content-Type: application/json' \
  -d '{"text":"ერთი ხაჭაპური და ორი ხინკალი","locale":"ka"}'
```

**Invalid body (empty text) → 400:**

```sh
curl -s -i http://localhost:8787/parse-meal \
  -H 'Content-Type: application/json' \
  -d '{"text":"  ","locale":"en"}'
# HTTP/1.1 400 Bad Request
# {"error":"empty_text"}
```

---

## Deploy

After `wrangler login` and `wrangler secret put ANTHROPIC_API_KEY` (steps 1 & 3 above):

```sh
npm run deploy
```

Wrangler prints the live URL. The endpoint is:

```
https://fitconnect-worker.<your-subdomain>.workers.dev/parse-meal
```

Smoke-test it with the same curls, swapping the host for your `*.workers.dev` URL.

---

## Notes

- **CORS** is currently open to all origins (`Access-Control-Allow-Origin: *`) for the mobile app.
  Tighten it to specific origins before a public web launch.
- **Rate limiting** is an in-memory, per-isolate best-effort guard (see the comment in
  [`src/index.ts`](src/index.ts)). It is *not* a true global limit — for that, use a Durable
  Object, KV, or Cloudflare's Rate Limiting binding.
- The model output is parsed **defensively** (fences stripped, `JSON.parse` in try/catch, shape
  validated, negatives clamped, items capped at 10). Anthropic's
  [structured outputs](https://docs.anthropic.com/) would be a clean future upgrade to guarantee
  schema-valid JSON.
