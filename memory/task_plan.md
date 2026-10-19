# gods-eye-view — task plan (open punch list)

- [ ] **FIRMS + AISStream free API keys** — Andrew must register; both layers show a KEY REQUIRED
      state until then. Carried over from the 2026-08-29 entry in `_categories\AI-OS\memory\decisions.md`.
- [ ] **Not in the attack-surface inventory.** `_shared\security\attacksurface.md` has no
      `gods-eye-view` entry, yet the app is publicly reachable (password-gated) on Cloud Run and holds
      a live `.env` including `OPENAI_API_KEY` and an unrestricted `GOOGLE_MAPS_API_KEY`. Add one.
- [ ] `celestrak.org` outage is worked around by baked `seed-cache/` (16,049 TLEs). Self-heals when
      celestrak returns — drop the seed cache then if image size matters.
- [ ] **Deploy the 2026-10-16 merge (not done; needs Andrew's go).** Bump `_IMAGE` past v14 in
      cloudbuild.yaml and `-Image` in scripts/deploy-cloudrun.ps1, build, then deploy ONLY through
      that script: it now sets `GEV_ALLOWED_HOSTS` to the service's exact hostnames. The live value
      `.run.app` is a suffix, which upstream's Host check (build/allowedHosts.js) drops by design;
      a deploy that keeps it 403s every request. Verified 2026-10-16.
- [ ] **OpenAI key answers 429 to `/api/openai/hud-summary`** (proxy body "OpenAI HUD summary
      request failed"; not the local limiter). Seen 2026-10-16 from the local .env key. Likely
      account quota; voice uses the same key. Check OpenAI → Usage/Limits.
- [ ] Upstream's `allowDistant` resolver flag bypasses only the anchor proximity gate, not the
      footprint gate — the same asymmetry src/annotations/gateParity.test.mjs exists to prevent.
      Not fixed in the merge (upstream behavior); candidate follow-up.
