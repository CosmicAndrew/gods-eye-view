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

## Round 2 — auth gate review (Codex unavailable, degraded to Gemini + Grok)

Codex: repaired (models_cache.json had a model entry missing `base_instructions`;
backed up + removed, cache regenerated, probe returned OK). Then hit its usage
limit mid-review. The gate STILL has no Codex review.

Gemini: found the real fail-open defect, but ALL FOUR verbatim quotes were
fabricated despite being explicitly told to quote or stay silent (cited line 13
and 18 - both comments; line 30 - the function signature; clientKey:42 -
`.filter(Boolean);`). Its "megabytes of base64 DoS" is false: Node caps headers
at 16,384 bytes. Findings treated as leads and verified individually.

Grok: strongest of the three. clientKey citations 100% accurate; basicAuthGate
line numbers wrong and one quote fabricated (`L34 if (!armed) return;` does not
exist), because it reasoned over a version without the `required` block. It also
CORRECTED a false premise in my own prompt: Node discards a duplicate
Authorization header and keeps the first, never an array - only set-cookie is
array-valued.

Fixed in round 2, each verified against the code first:
  D1 public bind via `vite preview --host 0.0.0.0` left the gate uninstalled,
     because `required` came from env.HOST which that path never sets. Now
     derived from the host Vite actually bound.
  D2 the length check returned early, leaking credential byte length - and the
     comment above it claimed the opposite. Now digests both sides first.
  D6 auth-scheme matched case-sensitively; RFC 7235 says insensitive.
  D5 `1.2.3.4`, `1.2.3.4:443` and `::ffff:1.2.3.4` were three rate-limit buckets.

Accepted, not fixed: D3 (XFF slot is attacker-shiftable if GEV_TRUSTED_PROXY_HOPS
exceeds what the platform appends - an operator error, and the safe direction is
already the default of 0); D4 (falling back to the shared bucket is deliberate
and no worse than the pre-fix behaviour); D7 (dead defensive code).

Unverified, left open: WebSocket upgrades never traverse the connect stack, so
the gate cannot see them. Only matters if a deployment runs dev mode rather than
preview; this one runs preview.

## Round 3 — closing Grok's open item

"WebSocket upgrades never traverse the connect stack, so the gate cannot see
them" — VERIFIED AS NOT A HOLE. No inbound WebSocket server is registered
anywhere in vite.config.js (no WebSocketServer, handleUpgrade, or 'upgrade'
listener; the AIS socket is outbound only), and an upgrade request against the
live deployment returns 401. The gate catches it.

Also fixed a self-inflicted regression: deploy credentials in .env arm the gate
on localhost too, so a fresh local run started demanding a password. The gate
was NOT weakened - run-windows.ps1 now prints the credentials, because silently
ignoring configured credentials is the worse trade.
