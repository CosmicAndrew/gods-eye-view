# gods-eye-view production-readiness route

Codex: FAILED - local model cache corrupt ("failed to load models cache: missing
field `base_instructions`"). Probed OK on the self-check, then could not review.
The auth gate therefore carries NO Codex review; see "unreviewed" note below.

Gemini: returned a structured gap list. EVERY file:line citation was wrong
(_overpassCache 160 vs 182, _routeCache 403 vs 359, getOpenSkyToken 1888 vs
1365, Dockerfile:89 is a comment). Symbols existed, so findings were treated as
leads and verified against the code individually rather than trusted. Three held
(no unhandledRejection handler, no SIGTERM, no health endpoint); one was FALSE -
"unbounded in-memory caches" - the caches do evict.

Grok: strongest of the three. Reframed the question away from "vite preview in
prod" toward Cloud Run's process model, and surfaced the X-Forwarded-For finding
unprompted. One of its findings was inverted (claimed npx is PID 1 citing
Dockerfile:92, which is the comment explaining why npx was removed).

Fixed this pass: process guards (unhandledRejection/uncaughtException/SIGTERM),
exec-form CMD so signals reach vite, clientKey trusted-proxy hops, keep-alive
timeouts above Cloud Run's idle window.

STILL UNREVIEWED BY A BROTHER: src/server/basicAuthGate.js, the only control
preventing public spend. Codex is the designated reviewer and was unavailable.
