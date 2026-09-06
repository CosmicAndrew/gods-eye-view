# gods-eye-view — task plan (open punch list)

- [ ] **FIRMS + AISStream free API keys** — Andrew must register; both layers show a KEY REQUIRED
      state until then. Carried over from the 2026-08-29 entry in `_categories\AI-OS\memory\decisions.md`.
- [ ] **Not in the attack-surface inventory.** `_shared\security\attacksurface.md` has no
      `gods-eye-view` entry, yet the app is publicly reachable (password-gated) on Cloud Run and holds
      a live `.env` including `OPENAI_API_KEY` and an unrestricted `GOOGLE_MAPS_API_KEY`. Add one.
- [ ] `celestrak.org` outage is worked around by baked `seed-cache/` (16,049 TLEs). Self-heals when
      celestrak returns — drop the seed cache then if image size matters.
