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
