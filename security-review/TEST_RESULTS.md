# SquishyBot — Test Results

> The repository has **no test framework** (no vitest/jest/mocha; no `*.test.ts`), and a Discord bot
> cannot be exercised end-to-end here (it needs a live `DISCORD_BOT_TOKEN` + guild). Verification
> chosen with the maintainer: **`pnpm typecheck`** as the floor, plus targeted throwaway scripts for
> the two behavioural fixes. The throwaway scripts were run and then removed (no test infra added).

## Commands run

| Command | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✅ pass | baseline + after `ws` override (lockfile consistent) |
| `pnpm typecheck` (baseline, pre-change) | ✅ pass | confirmed green before any edit |
| `pnpm typecheck` (after each of 7 commits) | ✅ pass | green at every commit and at HEAD |
| `pnpm audit` | ✅ 2 → 1 moderate | `ws` advisory cleared; remaining `esbuild` is dev-only |
| ReDoS benchmark (throwaway `tsx` script) | ✅ pass | see below |
| SSRF redirect behaviour (throwaway `node` script, local 302 server) | ✅ pass | see below |
| Redis-auth regex classification (`node -e`) | ✅ pass | 5/5 URL cases correct |
| `docker compose config` (interpolation) | ✅ pass | unset `POSTGRES_PASSWORD` fails loudly as intended |

## H3 — RSS ReDoS fix (benchmark)
Throwaway `tsx` script against `parseFeed` (then deleted):
```
[H3] 900k unclosed <item> opens : 14ms   -> items=0      (old regex: extrapolated minutes)
[H3] 700k well-formed <item>     : 20ms   -> items=500    (cap enforced)
[sanity] normal RSS feed         : items=2, first="Hello"/https://example.com/a
[sanity] Atom <entry> feed       : items=1, id="e1"
ALL RSS PARSER CHECKS PASSED ✅
```
Conclusion: the quadratic blow-up is gone (linear `indexOf` scan + 500-item cap), and normal
RSS/Atom parsing is unchanged.

## M1 — SSRF redirect fix (behavioural verification)
Confirmed empirically that Node/undici `fetch(..., { redirect: 'manual' })` returns the **real 3xx**
response (`status=302`, `type='basic'`, `Location` header readable) — **not** an opaque-redirect —
so the manual re-validation loop is sound. A local server `/start → 302 → /final → 200` was followed
correctly hop-by-hop, with `assertSafeOutboundUrl` re-run on each hop. (A genuine public→private
redirect can't be simulated offline because the first hop's allowlist already blocks loopback; the
re-validation logic and the undici primitive were both verified.)

## Coverage of fixes by verification
| Finding | Verified by |
|---|---|
| H1 `/color` | typecheck + manual code trace (logic: membership + `isAssignableRole`) |
| H2 rxnroles/messageReaction | typecheck + manual code trace (guard at create + grant sink) |
| H3 ReDoS | **benchmark** (above) |
| M1 SSRF redirect | **undici primitive + loop behaviour test** (above) |
| H4 non-root | Dockerfile inspection (`USER node`) |
| M2 DB password | `docker compose config` (fail-loud confirmed) |
| L1 redaction | typecheck (`env.BOTPANEL_RPC_SECRET` resolves) |
| L3 `ws` | `pnpm audit` 2→1, resolved version `ws@8.21.0` |
| L4 replay window | typecheck + manual trace |
| H6 nudge | regex classification test (5/5) |
| I1 perms | YAML lint |

## What was NOT testable here (and why)
- **Runtime Discord behaviour** (actual button clicks, reaction grants, voice flows) — needs a live
  token + guild. Recommend a manual smoke test in a test guild after deploy: try `/color` with a
  tampered select value (should reject), and confirm a normal color pick still works.
- **Full deploy pipeline** — only runs on push to `main`; validate via the PR's CI build.
