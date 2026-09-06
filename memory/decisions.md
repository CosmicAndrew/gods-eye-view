# gods-eye-view — decisions (why-ledger)

Format: `YYYY-MM-DD · what · why`.

**The substantive history for this project lives in `_categories\AI-OS\memory\decisions.md`** —
entries dated 2026-08-27 (clone + preview-parity fix), 2026-08-28 (deploy: here.now rejected,
password-gated Node host chosen), and 2026-08-29 (live on Cloud Run; three failures diagnosed).
It is **not duplicated here** — Iron Law 2: links, not copies. Read it there.

New decisions from here on are recorded in this file; the AI-OS ledger keeps the category-level view.

---

- `2026-09-06` · **Project capsule retrofitted.** The repo was one of four failing
  `validate_sweep.mjs` — it had README, .gitignore and git, but no `CLAUDE.md` and no `memory/`
  ledgers, so it failed the bootstrap standard while being 920 files of live, actively-developed
  work (last written 2026-09-02). Added the capsule and these three ledgers, plus `.tmp/` to
  `.gitignore`. No project content was touched. The capsule records the six repo-specific hazards
  that were previously only discoverable by reading the AI-OS ledger end to end — chiefly that
  `origin` is Bilawal's repo and this branch is never pushed, and that the Google Maps key is baked
  into the bundle so the auth gate must stay the first plugin.
