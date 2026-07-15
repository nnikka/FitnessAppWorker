# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Cloudflare Worker that proxies AI meal parsing for a mobile fitness app. It exposes
one endpoint, `POST /parse-meal`, which takes a free-text meal description (English or Georgian) and
returns structured food items with calories and macros by calling Anthropic's Messages API. The
entire implementation lives in [src/index.ts](src/index.ts).

The Worker exists so the **Anthropic API key stays server-side** (`env.ANTHROPIC_API_KEY`, a Worker
secret) and never ships in the mobile app bundle.

## Commands

```sh
npm run dev        # wrangler dev — serves on http://localhost:8787
npm run deploy     # wrangler deploy — deploys to Cloudflare
npm run typecheck  # tsc --noEmit — the only "test" step; run before deploying
npm run types      # regenerate Cloudflare Worker type definitions
```

There is **no test suite and no linter**. `npm run typecheck` (strict mode, with
`noUncheckedIndexedAccess`) is the correctness gate. Verify behavior manually with curl against
`npm run dev` — see the README for ready-made English/Georgian/error-case curls.

## Secrets & local setup

- **Local dev:** the Anthropic key goes in `.dev.vars` (gitignored) as `ANTHROPIC_API_KEY=sk-ant-...`.
- **Production:** set via `npx wrangler secret put ANTHROPIC_API_KEY` — never in `wrangler.jsonc`.
- Deploying also requires a one-time `npx wrangler login`.

## Architecture notes

The request flow in `fetch()` is: CORS preflight → path/method routing → per-IP rate check →
`handleParseMeal` (validate body → `callAnthropic` → `parseItems`). A few design choices are
deliberate and worth preserving:

- **Never leak upstream errors to the client.** Anthropic failures (network, non-200, unparseable)
  are `console.error`'d server-side and returned to the client as a generic `502 upstream_error`.
  The one passthrough exception is Anthropic's `429`, surfaced as the client's `429 rate_limited`.
- **The model output is untrusted and parsed defensively** (`stripFences` → `JSON.parse` in
  try/catch → shape validation → negatives/NaN clamped to 0 via `clampInt` → capped at `MAX_ITEMS`).
  The system prompt asks for strict JSON, but the parser never assumes it got it. If you change the
  response shape, change `SYSTEM_PROMPT`, the `FoodItem` interface, and `parseItems` together.
- **Rate limiting is intentionally weak.** The `hits` Map lives in one isolate's memory, so it is a
  best-effort per-IP speed bump (~20 req/60s), NOT a global limit — a client can bypass it by
  landing on other isolates. Don't treat it as real protection; a Durable Object / KV / Rate
  Limiting binding would be needed for that.
- **Locale is a hint only.** Item names come back in the input's language regardless of the `locale`
  field; the prompt handles Georgian dishes natively.
- **CORS is open to all origins** (`Access-Control-Allow-Origin: *`) for the mobile app. Tighten
  before any public web launch.

## Model

Uses `claude-haiku-4-5` (cheapest/fastest tier, supports `temperature`), pinned in the `MODEL`
constant. `anthropic-version` is `2023-06-01`.
