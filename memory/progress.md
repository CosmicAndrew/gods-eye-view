# gods-eye-view — progress (what-ledger)

- `2026-09-06` · Capsule + memory ledgers retrofitted; repo now conforms to the bootstrap standard
  (`validate_project_structure.mjs` exit 0). No source changes.
- Earlier progress is recorded in `_categories\AI-OS\memory\decisions.md` (2026-08-27 → 08-29):
  cloned and stood up local-only, preview-parity fix that restored ten silently-lost data proxies,
  password gate + Dockerfile, and the Cloud Run deployment at
  `gods-eye-view-808373260790.us-central1.run.app`. Test baseline **2791, 0 fail**.

- 2026-09-10 — Merged upstream main 7596522 (v0.1.1 keyless boot, Provider Settings,
  Pinokio, CI) into feat/windows-preview-parity as one merge commit; tag
  pre-upstream-merge-2026-09-09 is the revert point. Live on Cloud Run as
  **v14 / gods-eye-view-00016-44q**. Image 147.7 -> 117.1 MB compressed by
  dropping build-only Cesium from the runtime stage. Windows numbers now in
  docs/PERFORMANCE-WINDOWS.md; the RTX column is empty because the GPU is at
  problem code 43 and needs a full power-down.

- 2026-10-16 — Merged upstream main 3e5a18f6 (1,387 commits, v0.2.1+: provider split into
  server/ and build/, MCP, i18n, CCTV/transit/radar packs, web manifest) into a merge branch off
  feat/windows-preview-parity; tag pre-upstream-merge-2026-10-16 is the revert point. Upstream
  dissolved vite.config.js, so our fixes were re-applied at their new homes rather than merged by
  line. Our Cloud Run image moved to Dockerfile.cloudrun (upstream now owns Dockerfile for compose).
  7783 tests, 0 fail. NOT deployed: GEV_ALLOWED_HOSTS on Cloud Run must change first (task_plan).

## 2026-10-17 - v16 live (revision gods-eye-view-00018-mlh)
- OpenAI key is 429 credit_balance_exhausted. HUD summary now falls back across Gemini, DeepSeek, OpenRouter (keys from the Windows user env, passed by deploy-cloudrun.ps1; order GEV_HUD_SUMMARY_PROVIDERS in .env). Voice is still OpenAI Realtime only.
- Footprint gate now honours upstream's allowDistant (gateParity reads the bypass list off the anchor gate).
- Merge regression found live on v15: upstream same-site gate 403'd every cost endpoint behind Cloud Run. Fixed in v16 behind GEV_TRUSTED_PROXY_HOPS.
- Live checks: 401 unauthed, 200 authed on both hostnames, HUD summary 200 with text, realtime token 200, cross-site 403, setup/status 404.

## 2026-10-18 - v19 live (revision gods-eye-view-00023-zhw)
- Open voice engine (GEV_VOICE_ENGINE=open): Groq Whisper in; DeepSeek/OpenRouter/Gemini reply; speech from Fish s2.1-pro-free (free API model; paid S2 models 402), then ElevenLabs v4 on fal, then Chatterbox on DeepInfra, then browser voice. v17/v18 shipped it.
- Merged upstream main 93ea088f (65 commits). Auth gate moved to server/standalone/basic-auth-gate.js (node:crypto under src/ failed check:boundaries); our modules registered in package-boundaries.json; formatter run.
- All CI gates green locally: 7871 tests 0 fail, build, check:boundaries, format:check, layer-token, qa:panel-resize, qa:street-level:fixtures 39/39. Paris open-voice harness PASS.
- Live: 401/200 on both hostnames, speak 200 via fish. Branch pushed to CosmicAndrew/gods-eye-view (Andrew's fork); origin (upstream) is read-only and untouched.

## 2026-10-24 - v20 live (revision gods-eye-view-00024-k7k)
- New gate password (old one rejected, 401); FIRMS 200 with live VIIRS rows; AISStream ships 200; Google text search 200 on GOOGLE_MAPS_SERVER_API_KEY.
- Browser Maps key now referrer-restricted: tiles 200 with the site referrer, 403 with a foreign one.
- Server key Geocoding API added 2026-10-24; live geocode "Paris" returns OK.

- 2026-10-24: Traced perimeters restored. Upstream (#742) left Overpass unconfigured by default and public instances refuse traffic, so every area annotation stayed a point. Added `/api/geocode/outline` (Nominatim polygons on the shared 1 req/s queue, name-matched to the ask) as the resolver fallback when Overpass is unavailable. qa-outline-render 2/2 traced; 7877 tests pass.

- 2026-10-25: Open voice pacing and turn log (not yet deployed). Live v22 speak calls ran up to 6.8 s, past the client's 4 s deadline; a first chunk that slow hands the rest of the reply to the browser voice. `speechChunks` now caps the opening chunk at 80 chars and each later one at 80 + 3x the chunk before, cut at a clause (Fish measured 0.8 s + 23 ms/char; 83 chars = 2.3-2.6 s). With GEV_VOICE_LOG_CONTENT=1, /api/voice/open/respond prints one `open_voice.turn` JSON line per turn (heard, reply, tool calls) to stdout, which Cloud Logging keeps. 7882 pass 0 fail, build, boundaries, format OK; qa-open-voice PASS locally (fish, first chunk after 1.0 s).

- 2026-10-25: Everything highlightable (3b61366a, after f455513f's flat fallback outlines; not yet deployed). Roads/rivers trace as buffered centrelines, the pointer spot or an unmatched name reverse-looks-up the feature at the anchor, a missing outline becomes an approximate ground ring (never a dot), and annotate_map `entity` rings a live aircraft/ship/satellite that follows it. Local qa-outline-render 5/5 traced (Lombard St, Embarcadero, Mission Creek, two bare coordinates); a ring on AFR099 moved with it. 7890 pass 0 fail, format and boundaries OK.
