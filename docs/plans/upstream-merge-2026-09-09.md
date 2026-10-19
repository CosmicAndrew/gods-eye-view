# Update gods-eye-view to newest upstream, then optimize (measurement-first)

## Context

Andrew's fork (`C:\Users\admin\Projects\gods-eye-view`, branch `feat/windows-preview-parity`, 25 local
commits, never pushed) is based on upstream `main` at `b22573a` (Aug 27). Upstream is now at
`7596522` (Sep 5): 20 commits — v0.1.0/v0.1.1 keyless boot + in-app Provider Settings + Pinokio
one-click install, a FIRMS fix that silently dropped 2 of 3 VIIRS sources, an Overpass
mirror-rotation/cache-poisoning fix, CI, `.gitattributes`, 14 new test files. "Update the newest" =
bring those in without losing our Windows/Cloud-Run/voice work. "Optimize" = the repo's own rule
applies: **measure before optimizing** — the only documented baseline is one Apple M5 capture that
says outright "This report does not establish Windows performance", and the frame-rate harness we
used last session reads `window.viewer`, which is never assigned, so it has been sampling a parked
camera. Fix the instruments, capture a real RTX baseline, tune only measured deficits, shrink the
image, deploy v14.

**Decisions already made:** Cloud Run instance settings stay as-is (min 0, throttled CPU; Andrew
chose "leave as-is, shrink the image"). Category **AI-OS**. Merge, not rebase. Local-only fork: no
push, no upstream PR. Production served by `vite preview` behind the basic-auth gate (never static).

**Baselines to record at start:** `npm test` (last known 2,662 pass / 0 fail), `git status` clean,
`Get-PnpDevice -Class Display` shows the NVIDIA row `OK` (if not: `pnputil /restart-device`, then
`scripts/qa-gpu-matrix.mjs --runs 3`; never record an Intel run as the RTX baseline).

## Skills to invoke during execution
`superpowers:test-driven-development` (every code change), `superpowers:systematic-debugging` (any
harness/merge failure), `superpowers:verification-before-completion` (final gate). Read
`_shared\BRANCHING.md` (done in planning) — plan doc copies to `docs/plans/upstream-merge-2026-09-09.md`.

---

## Phase A — Update: merge upstream `main` (7596522)

**Topology (verified):** local `main` b22573a is NOT an ancestor of upstream; Bilawal re-committed
the identical README change as 314a0e1. True merge base = `880a672`. Overlap with our 50 changed
files is 7: `vite.config.js` (4 regions), `.gitignore`, `README.md`, `.env.example` (ours are
byte-identical to 314a0e1 → take theirs), `src/main.js`, `src/annotations/annotationResolver.js`,
`src/data/aisLiveVessels.test.mjs` (last three auto-merge). No overlap on `src/voice/gevRealtime.js`,
`src/server/*`, `Dockerfile`, `package.json`, our `scripts/qa-*.mjs`.

**Why merge, not rebase:** 7 of our 25 commits touch `vite.config.js` at the same anchor upstream
inserted 264 lines; a rebase replays that conflict up to 7 times and rewrites 25 SHAs cited in
ledgers. One merge commit, one resolution, one revert point.

### A1. RED tests first (Protocol 0) — commit before merging
Extend `src/viteProxyParity.test.mjs` (behavioral style: `configFactory({ mode:'development', command:'serve' })`):
1. `plugins[0].name === 'basic-auth-gate'` (green today; guards the merge).
2. Plugin `gev-key-setup` exists, has **no** `configurePreviewServer`, and `apply({}, {command:'serve', isPreview:true}) === false` (RED now — plugin absent; RED if wrapped by `alsoServePreview`). Reason: it writes the repo `.env` and reports which credentials exist; `alsoServePreview` (`vite.config.js:7350-7353`) would promote it onto Cloud Run behind only basic auth.
3. `config.preview.headers` deep-equals `config.server.headers` and includes `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` (RED now).

New `src/server/dockerRuntimeImports.test.mjs` (source-anchor style of `src/gpuPreference.test.mjs`):
every relative `from './…'` import in `vite.config.js` must have its top path copied by a
`COPY --from=build /app/<p>` line in the Dockerfile runtime stage. Green now; **RED the moment the
merge lands** because upstream adds `import … from './scripts/pinokio-environment.mjs'` and the
runtime stage (`Dockerfile:72-79`) never copies `scripts/` → container crashes at PID 1.

### A2. Git procedure (from the canonical repo; show destructive commands before running)
```
git status --porcelain                      # must be empty
git tag pre-upstream-merge-2026-09-09        # revert point
git fetch origin main                        # remote-tracking ref only
git merge-base HEAD origin/main              # expect 880a672
git merge --no-ff origin/main                # halts on vite.config.js .gitignore README.md .env.example
git checkout --theirs -- README.md .env.example
git checkout --conflict=diff3 -- vite.config.js .gitignore
# hand-resolve per A3, then:
npm ci && npm test && npm run build          # green BEFORE committing
git add README.md .env.example .gitignore vite.config.js
git commit                                   # message names the plan doc; Co-Authored-By: Claude Fable 5.1
```
Abort: `git merge --abort` mid-merge; after commit `git reset --hard pre-upstream-merge-2026-09-09`
(destructive — confirm first). Never `git add --renormalize .`; never `git push`.

### A3. Resolved shapes in `vite.config.js` (our current line numbers)
- **Helpers (after `normalizeAisTimestamp`, 7338):** keep our `alsoServePreview` (7340-7353), then
  upstream's `keySetupEndpoint` function verbatim. Upstream's new imports/`PROVIDER_ENV_AT_BOOT`
  const auto-merge — do not touch (`src/keySetupCore.test.mjs` regex-anchors that line).
- **Factory head (7362-7376):** `installProcessGuards(...)` stays first; then loadEnv loop; then
  upstream's `const localAllowedHosts = [...]`; add `const frameDenyHeaders = { 'X-Frame-Options':
  'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }` (single source for both blocks).
- **Plugins (7377-7427):** order unchanged — `basicAuthGate` first, `immutableAssets()`,
  `keepalive-timeouts`, `cesium()`, `...[19 proxies].map(alsoServePreview)`, **then
  `keySetupEndpoint()` as the last element, outside the spread**, with a one-line comment.
- **server/preview (7428-7452):** `server` takes upstream's shape (port default 4173, `fs.deny`,
  `headers: frameDenyHeaders`); `preview` keeps ours + `headers: frameDenyHeaders` (Vite 6
  `PreviewOptions` carries `headers`).
- `.gitignore`: keep both EOF appends. `src/main.js`: auto-merges; eyeball that
  `powerPreference: 'high-performance'` is still inside `contextOptions.webgl` (pinned test).

### A4. Post-merge
1. `npm ci` (lockfile changed) → `npm test` → 0 fail; **record the new count**, update the
   baseline line in repo `CLAUDE.md` and `memory/progress.md`.
2. `npm audit` — upstream lock downgrades `dompurify` 3.4.14→3.4.10 and `protobufjs` 8.7.2→8.6.4;
   accept upstream's lock (matches its CI); bump only if audit flags.
3. `npm run doctor -- --json` exits 0 (new CI gate; it only checks node/npm/deps/credential presence).
4. Dockerfile fix cycle: `dockerRuntimeImports.test.mjs` RED → add
   `COPY --from=build /app/scripts/pinokio-environment.mjs ./scripts/pinokio-environment.mjs` after the
   `src` COPY (`Dockerfile:77`) → GREEN → commit.
5. `npm run build` → `vite preview` → `node scripts/qa-boot-smoke.mjs --headful --force-gpu` ;
   `curl -sI localhost:4173/` shows both frame headers; `curl …/api/setup/status` → 404.
   Console must show Google 3D Tiles loaded (keyless boot now masks a missing baked key).
6. Voice sanity: `scripts/qa-voice-session.mjs`, then `scripts/qa-voice-replay.mjs --only 9` (airport
   fix) and `scripts/qa-bargein-live.mjs` (exits 2 when rate-limited — not a failure).
7. Harness follow-ups (separate commits): boot-smoke asserts active stack is `photoreal` (Esri
   fallback measures a different scene); `qa-layer-errors`/`qa-fps-under-load`/`qa-gpu-matrix` same
   assertion + whitelist Esri 4xx noise; grep voice harnesses for the old 4-stack list (`set_map_stack`
   enum now includes `esri-imagery`).
8. Write `docs/plans/upstream-merge-2026-09-09.md`; note in `docs/DEPLOY-PRIVATE.md` that
   `/api/setup/*` is absent in preview by design.

---

## Phase B — Fix the instruments, capture the Windows baseline

### B1. RED: `src/qaHarnessViewerGlobal.test.mjs` (gpuPreference style, readFileSync + regex)
- `src/main.js` exposes `viewer` inside `window.__godsEyeView = { … }` (main.js:320-321).
- `scripts/qa-fps-under-load.mjs` and `scripts/qa-boot-smoke.mjs` match `window.__godsEyeView?.viewer`
  and do NOT match `window\.viewer\b`.
- `qa-fps-under-load.mjs` throws when the camera is missing (a parked camera must fail, never report).
RED today (`qa-fps-under-load.mjs:69`, `qa-boot-smoke.mjs:79,113-114`).

### B2. GREEN: minimal harness fixes + two flags
- Replace the global; wait on `window.__godsEyeView?.viewer` before sampling; throw if absent.
- `--dpr` (default 1; `page.setViewport deviceScaleFactor`) and `--scene` (default `layers5` = today's
  behavior). Scenes mirror `docs/PERFORMANCE.md:63-112`, driven via `window.__godsEyeView`:
  `normal` (all layers off), `snow` (`styleManager.setStyle('snow')`), `detection100`
  (`styleManager.setDetection({enabled:true, densityPct:100})`), `flights3d` (enable `flights`,
  `module.setParams({models3d:true, models3dMode:'all'})`), `ais` (enable `ais-live-vessels`, skip if
  `keyRequired`), `traffic` (enable `traffic`, Austin view ≤ 8 km altitude). Verify each accessor at
  execution (`manager.js:958 setEnabled`, `ui.js:8981/7841`, `flights.js:4731`).
- Sample 5 s motion + 5 s rest (PERFORMANCE.md:127); output both plus `p95Ms`, `stallsOver100ms`,
  `throttled`, `gpu`, `dpr`, `scene`, object count where cheap (else `null`).
- Do not touch the other ~40 `qa-*.mjs` (they already use `__godsEyeView`).

### B3. Capture → new `docs/PERFORMANCE-WINDOWS.md`
(sibling file, so it cannot conflict with upstream-owned `docs/PERFORMANCE.md`)
Preview build via `.\scripts\run-windows.ps1 -SkipBuild`, 1440×900, DPR 1, focused, 3 runs/scene,
medians. Runs: boot-smoke ×3 (`readyMs`, renderer must contain NVIDIA); `qa-fps-under-load --gpu
--dpr 1 --scene <6 scenes + layers5>` ×3; the six scenes once **without** `--gpu` (tests the page's
own `powerPreference` request — Intel here is a finding); `normal` + one deficit scene at `--dpr 1.5`
(lived experience) and `--dpr 0.5` (fill-rate probe). Record GPU/driver/Chrome/refresh/power plan.
**Deficit rule for Phase C: median motion fps on the RTX at DPR 1 < 55.**

---

## Phase C — Client tuning, each conditional on a Phase-B deficit

Common acceptance: `npm test` green, `scripts/qa-perf.mjs` green (verify at execution whether it
needs the dev server), ≥ 10% median motion-fps gain on the deficit scene over 3 runs, side-by-side
crop at the Austin view acceptable. Revert on any failure; log the number under "Tried and reverted"
in `docs/PERFORMANCE-WINDOWS.md`. Each kept value gets a comment + source-anchor pin. Do Phase C
**after** Phase A (item 1 sits in the `main.js` boot region upstream rewrote).

1. `maximumScreenSpaceError` on the photoreal tileset (`src/main.js:166-169`, default 16; only repo
   precedent `tools/cesium-render.html:90`): try 24, 32 as a factory option; verify the factory
   forwards it. Side effect worth recording: fewer Google tile requests.
2. `msaaSamples: 4 → 2` (`main.js:119`, a restated Cesium default) — only if the deficit scene
   speeds up markedly at `--dpr 0.5` (fill-rate bound); check a 200% edge crop. `preserveDrawingBuffer`
   stays (pinned).
3. `skipLevelOfDetail: true` — only if the deficit is in p95/stalls during motion, not median fps.
4. One layer budget per deficit scene only, each with existing doc guidance: detection 100-column
   (`src/data/detectionPolicy.js:104-113`, −25%); `MAX_DOTS` 6000→4000 (`src/data/traffic.js:57`);
   `VESSEL_DEFAULT_LABEL_LIMIT` 900→600 (`src/data/vesselLabels.js:11`); `MODEL_MAX_ALL` 350→250
   (`src/data/flights.js:165`). Detection stays ON by default (owner directive `ui.js:393-403`).
5. Snow shader 5→4 layers (`src/styles/snow.js:76-80`) — lowest rank, opt-in style.
Measure-only: sharpen default ON (`ui.js:390`) — record the delta, no change.

---

## Phase D — Transfer, image, cold start (unconditional; Andrew chose "leave instances as-is")

**D1. Transfer — measure, probably no change.** Reading vite's bundled server: sirv emits an empty
`Content-Type` for `.geojsonl` (unknown extension) and vite's `compression()` falls back to
`text/plain`, which matches its MIME regex — so the 2.56 MB datacenters and 730 KB dams files are
likely already gzipped. Prove with `curl -sI -H "Accept-Encoding: gzip"` on both assets, `regions-*.js`,
`/cesium/Cesium.js`; record raw vs on-wire bytes. Only if `content-encoding` is absent: a ~15-line
middleware beside `src/server/immutableAssets.js` setting `Content-Type: text/plain` for `*.geojsonl`
(same setHeader-pinning trick, unit test in `immutableAssets.test.mjs` style). Precompressed `.br`
rejected (needs a custom static handler). Duplicated `.js/.json` pairs are disk-only — no action.

**D2. Image prune (TDD via the delete-and-boot test).**
1. Trace the runtime import graph: scratchpad `module.register()` resolve-hook logger, run
   `node --import trace.mjs node_modules/vite/bin/vite.js preview`, hit `/` and one `/api/*`, list
   unique `node_modules/<pkg>`. Expected from reading `vite-plugin-cesium/dist/index.js:36-121`:
   `node_modules/cesium` (74 MB) + `@cesium` (28 MB) are touched only in `configureServer`/`closeBundle`,
   i.e. never at preview boot; `ws` loads lazily via `createRequire`.
2. Prove: `docker run --rm --entrypoint sh IMAGE -c 'rm -rf node_modules/cesium node_modules/@cesium && node node_modules/vite/bin/vite.js preview'` + boot-smoke passes.
3. Apply only what step 1 proves unused: `Dockerfile:52-60` rm list += `node_modules/cesium
   node_modules/@cesium`; `.dockerignore` += `src/**/*.test.mjs` (165 files ship today via `COPY src`),
   `four-brothers-out`, `memory`, `tools`, remaining `docs`. Keep `seed-cache`, `config`, `public`.
   Build locally once before Cloud Build (the build stage's `COPY . .` must still see everything it reads).
4. Correct `cloudbuild.yaml:2` "~900 MB" if measured otherwise.

**D3. Deploy-script hygiene.** `scripts/deploy-cloudrun.ps1:21` default image `:v1` → live tag;
add `--cpu-boost` explicitly (it is on today only by Cloud Run default). Same for `cloudbuild.yaml:22`.
Do **not** add `--min-instances`/`--no-cpu-throttling` (decision: leave as-is).

**D4. Measure before/after:** image size via `docker manifest inspect IMAGE:TAG | jq
'[.layers[].size]|add'` (v13 vs v14); cold start via `curl -u … -w "%{http_code} %{time_starttransfer}"`
×3 after ≥ 20 min idle (or immediately after a fresh revision), plus Cloud Monitoring
`container/startup_latencies`.

---

## Phase E — Ship v14 and verify live
Build with the global Cloud Build pool (`gcloud builds submit --config cloudbuild.yaml …:v14`),
deploy with `.\scripts\deploy-cloudrun.ps1 -Image …:v14` **from the PowerShell tool directly**, then:
gate 401 / authed 200 / `/api/realtime/token` 200 / `/api/ais-live` 200 / `/api/firms` 200; frame
headers present on the live URL; `/api/setup/status` 404; `qa-voice-replay.mjs --only 9` against the
live URL; cold-start sample per D4.

## Phase F — Log back (AI-OS)
`_categories\AI-OS\memory\decisions.md` (merge-not-rebase; key-setup outside preview; instances left
as-is with the cost table), `session-summaries.md` (before/after tables), `next-actions.md` (any
reverted experiments, harness follow-ups). Repo `memory/progress.md` + `CLAUDE.md` baseline count.
Republish the GEV Ground Station artifact with v14 facts. Run
`node ..\_shared\scripts\validate_project_structure.mjs .` (exit 0).

---

## Verification (end-to-end)
1. `npm test` 0 fail before and after every commit; counts recorded (pre-merge, post-merge, final).
2. Merge guards green: gate first, `gev-key-setup` has no preview hook, preview headers mirrored,
   Dockerfile copies every config import.
3. `docs/PERFORMANCE-WINDOWS.md` carries the RTX table (scene | objects | motion fps | rest fps |
   p95 | stalls | before → after | change) with 3-run medians, plus "Tried and reverted".
4. Transfer table (asset | raw | on-wire | content-encoding | content-type) from live curls.
5. Image/cold-start table (v13 vs v14: compressed layer bytes, packages loaded at boot, TTFB ×3).
6. Live v14 checks in Phase E all pass; voice airport command still marks both airports.

## Risks (one line each)
- Key-setup endpoint reaches Cloud Run → pinned by the RED parity test; its own `apply` guard is the second layer.
- Runtime image crashes on `./scripts/pinokio-environment.mjs` → `dockerRuntimeImports.test.mjs` + local `docker run` before Cloud Build.
- Keyless boot hides a missing baked Maps key → boot-smoke asserts Google 3D Tiles loaded / stack `photoreal`.
- Lockfile downgrades carry a CVE → `npm audit` gate.
- Hybrid-GPU capture silently lands on Intel → harness `gpu` field + `Get-PnpDevice` guard; RTX may drop off the bus mid-session.
- Deleting `node_modules/cesium` breaks preview → delete-and-boot test is the gate; revert if any proxy imports it.
- `.geojsonl` "uncompressed" claim is probably wrong → curl before code.
- Tileset SSE / MSAA trade sharpness for fps → crops kept in the doc; revert below 10% gain.
- `qa-perf.mjs` may need the dev server → verify before using it as the post-change gate.
- Cold-start samples on a warm instance mislead → ≥ 20 min idle or fresh revision only.
- OpenAI realtime rate limit blocks live voice checks → exit-2 harness distinguishes blocked from failed.
