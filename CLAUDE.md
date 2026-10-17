# gods-eye-view — Project Capsule

**Category:** AI-OS (junctioned into `_categories\AI-OS\`; its why-ledger entries live there).
**Canonical home:** `C:\Users\admin\Projects\gods-eye-view` — git wired here; never edit through the
category junction (Iron Laws 1/3).
**What this is:** a **fork** of [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view)
(MIT) — a photorealistic 3D globe fed by live public data (aircraft, ships, satellites, earthquakes,
fires, traffic, cameras) with hands-free voice control via the OpenAI Realtime API. Andrew's work is
Windows/preview parity plus voice and layer fixes: **24 of 29 commits**, on
`feat/windows-preview-parity`.

## Hazards specific to this repo — read before touching it

1. **The branch is never pushed. `origin` is Bilawal's repo, not Andrew's.** Every local commit stays
   local by decision. Do not `git push`; do not open a PR upstream unless Andrew says so.
2. **There is no conventional backend.** Every `/api/*` route is **Vite plugin middleware** under
   `server/providers/`, composed by `server/standalone/vite.config.js` (root `vite.config.js` is a
   re-export since the 2026-10-16 upstream merge). A static host (Vercel, Netlify, here.now) serves the globe and silently loses
   every live layer and voice — `/api/realtime/token` mints the OpenAI session from the server's key
   and there is no server. This has already been diagnosed twice; do not re-propose static hosting.
3. **`GOOGLE_MAPS_API_KEY` is baked into the built bundle** (vite `define` injects at build time) and
   its Application restrictions are deliberately **None**, because one key serves both the browser
   and the Node proxy. Therefore `src/server/basicAuthGate.js` must stay the **FIRST** plugin —
   gating only `/api` still serves the key-bearing JS. It is unshifted with `enforce: 'pre'` in
   `server/standalone/vite.config.js`, because upstream's Host check is also `pre`. Publishing `dist/` unprotected hands out an
   unrestricted Enterprise-SKU key.
4. **`core.autocrlf` is `false` for this repo on purpose.** The global `true` breaks source-anchor
   tests that read files with `fs.readFileSync` (CRLF) and match template literals (LF). Fix per-repo,
   never upstream, never globally. See [[autocrlf-breaks-source-anchor-tests]].
5. **A fake-device voice pass is not evidence the mic works.** Every voice harness uses
   `--use-fake-device-for-media-stream`, which bypasses the OS audio stack; a muted mic and a working
   one look identical through it. Use `scripts/qa-mic-probe.mjs` for real per-device signal.
6. **Check the client's own call site before declaring an endpoint broken.** Several "broken" layers
   were wrong query params (aircraft wants `lat`/`lon`, terrain wants `lon,lat` order, regional-brief
   wants `latitude`/`longitude`).

## Deployment
Live on **Cloud Run**, password-gated: `gods-eye-view-808373260790.us-central1.run.app`. Railway was
abandoned (trial expired). The image is `Dockerfile.cloudrun` (cloudbuild.yaml passes `-f`); the plain
`Dockerfile` is upstream's compose dev container. **`GEV_ALLOWED_HOSTS` must be exact hostnames** —
upstream's Host check ignores suffix entries, so the `.run.app` value live until 2026-10-16 would 403
every request. `scripts/deploy-cloudrun.ps1` now reads them from the service's own URLs; deploy only
through it. Build with the **global** Cloud Build pool — the regional pool expires
without assigning a worker, and `E2_HIGHCPU_8` is quota-blocked on a new account. Do **not** set
`healthcheckPath`: with the gate armed every path answers 401, so a healthcheck fails a healthy
deploy. `npm ci --omit=dev` removes vite, which **is** the runtime here — remove puppeteer/sharp by
name instead. Details: `docs/DEPLOY-PRIVATE.md`.

## Governance — canonical, read don't restate (Iron Law #2)
- **Iron Laws / methodology:** `C:\Users\admin\Projects\_shared\METHODOLOGY.md`
- **Branching:** `C:\Users\admin\Projects\_shared\BRANCHING.md` — but see hazard 1: this fork's
  branches are local-only, so the push/cleanup half of that workflow does not apply here.

## Protocol 0 — build gate (Blueprint)
Before changing a proxy, a layer, or the voice path: (1) route the task; (2) **RED** — a failing test
that proves the gap (`src/viteProxyParity.test.mjs` is the model: it caught ten proxies that vanished
from `vite preview`); (3) **GREEN** — minimal change; (4) **REFACTOR** — `npm test` green before and
after; (5) log back. Baseline: **7783 tests, 0 fail, 10 skipped** (after the 2026-10-16 upstream merge). Measure before optimizing — `vite preview`
already gzips (1.35 MB → 417 KB) and `egm96-universal` is already lazy-imported.

## Memory ledgers (the capsule's brain)
- `memory/decisions.md` — why-ledger. **The substantive history for this project lives in
  `_categories\AI-OS\memory\decisions.md` (2026-08-27, 08-28, 08-29) and is deliberately NOT copied
  here** (Iron Law 2).
- `memory/progress.md` — what-ledger.
- `memory/task_plan.md` — open punch list.

## Structure conformance
Verify (exit 0 required): `node ..\_shared\scripts\validate_project_structure.mjs .`
