# SquishyBot — Dependency & SBOM Notes

**Package manager:** pnpm 10.33.2 (lockfileVersion 9.0), committed `pnpm-lock.yaml`, installed with
`--frozen-lockfile` in the Dockerfile build stage.

## Direct dependencies

| Package | Range | Resolved | Notes |
|---|---|---|---|
| discord.js | ^14.26.3 | 14.26.4 | current; pulls `undici@6.24.1`, `@discordjs/ws@1.2.3 → ws` |
| drizzle-orm | ^0.45.2 | 0.45.2 | ORM; `postgres` is a peer |
| ioredis | ^5.10.1 | 5.10.1 | event/command bus client |
| postgres | ^3.4.9 | 3.4.9 | pg driver |
| zod | ^4.4.1 | 4.4.3 | env + payload validation |
| dotenv | ^17.4.2 | 17.4.2 | — |
| **dev:** drizzle-kit | ^0.31.10 | — | **shipped into the runtime image** (used by `docker-entrypoint.sh`); drags vulnerable `esbuild` via the deprecated `@esbuild-kit/*` chain |
| **dev:** tsx, typescript, @types/node | — | — | build/dev only |

Production footprint: **29 top-level/direct-transitive packages, 67 transitive nodes**. No package
with a `postinstall` lifecycle script is approved to run (pnpm reports `esbuild` build scripts as
**ignored** — the safe default).

## `pnpm audit` results

| Before | After (this branch) |
|---|---|
| 2 moderate, 0 high/critical | **1 moderate, 0 high/critical** |

### Fixed
- **GHSA-58qx-3vcg-4xpx / CVE-2026-45736 — `ws@8.20.0` (moderate)** via `discord.js > @discordjs/ws > ws`. Uninitialized-memory disclosure on `ws.close(code, TypedArray)`. **Fixed** with a pnpm `overrides` entry `ws: ^8.20.1` → resolves to **8.21.0** (stays in the 8.x line discord.js expects; `--frozen-lockfile` re-verified, typecheck green).

### Remaining (intentionally not force-upgraded)
- **GHSA-67mh-4wv8-2f99 — `esbuild@0.18.20` (moderate)** via `drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild`. A dev-server CORS issue, **not exploitable at runtime** (no esbuild dev server runs in production). After the **H5** cutover the runtime no longer *executes* `drizzle-kit` at all (startup runs the drizzle-orm `migrate()` runner, not `push`), so this path is unreachable in prod — though `drizzle-kit` is still present in the copied `node_modules`. Fully removing it would require a production-only `node_modules` (e.g. `pnpm install --prod` in the image) or upgrading `drizzle-kit` to a release off `@esbuild-kit`.

## Supply-chain hygiene observations
- No typosquat-looking or abandoned direct dependencies; all direct deps are well-known and current.
- `^` ranges on direct deps are acceptable given the committed lockfile + `--frozen-lockfile` build.
- `.github/dependabot.yml` is sane: npm (grouped minor/patch, separate majors), docker, and github-actions ecosystems enabled — this will surface the L2 action-pin updates once the actions are pinned.

## SBOM
A full CycloneDX/SPDX SBOM could not be generated in-environment (`syft`/`cdxgen` not available).
Generate one in CI with, e.g.:
```bash
# CycloneDX for the production tree
pnpm dlx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.cdx.json
# or against the built image
syft ghcr.io/jason-tucker/squishybot:latest -o spdx-json > sbom.spdx.json
```
The `pnpm ls --prod --depth=Infinity` output is the authoritative interim component list.
