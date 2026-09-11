# Windows performance — measured

`docs/PERFORMANCE.md` is an Apple M5 capture and says so plainly: *"This report
does not establish Windows performance."* This file is that missing column.

Read the instrument note first. Every "under load" frame rate this repo produced
before 2026-09-10 was measured on a **parked camera**: `qa-fps-under-load.mjs`
drove the camera through `window.viewer`, a global the app has never assigned,
and optional chaining turned the mistake into a silent no-op. Numbers taken
before that fix are not comparable with anything here.

---

## Machine

| | |
|---|---|
| Laptop | Windows 11 Home 10.0.26200, hybrid graphics |
| Discrete | NVIDIA GeForce RTX 3080 Ti Laptop GPU |
| Integrated | Intel UHD Graphics |
| Browser | system Chrome, headful, 1440×900, DPR 1 |
| Server | production build via `vite preview` (not `npm run dev`) |

## Scene: 5 layers, camera in motion

`node scripts/qa-fps-under-load.mjs --gpu --layers 5` — flights, military,
earthquakes, satellites, rocket-launches. Camera rotating for the whole sample,
production build, 1440x900 at DPR 1, window focused.

| Run | GPU | fps | median frame | p95 | worst | stalls >100 ms | throttled |
|---|---|---|---|---|---|---|---|
| 1 | **NVIDIA** | 49.1 | 16.7 ms | 22.6 ms | 439.3 ms | 3 | false |
| 2 | **NVIDIA** | 59.8 | 16.7 ms | 18.0 ms | 48.8 ms | 0 | false |
| 3 | **NVIDIA** | 60.0 | 16.7 ms | 18.1 ms | 23.4 ms | 0 | false |
| A | Intel | 7.5 | 131.2 ms | 155.4 ms | 203.8 ms | 60 | false |
| B | Intel | 7.3 | 132.8 ms | 187.0 ms | 292.8 ms | 54 | false |

**Median frame is 16.7 ms in all three NVIDIA runs.** That is the 60 fps cap
(`viewer.targetFrameRate = 60`, `src/main.js`) — the scene renders at the
ceiling the app sets for itself, not below it.

Run 1's average is dragged to 49.1 by a single 439 ms stall on the first run
after a server start: cold tile cache and shader compilation. Runs 2 and 3, on a
warm cache, have **zero** stalls over 100 ms and a worst frame of 23-49 ms.

### The verdict: no deficit, so nothing was tuned

The rule set before measuring was *median motion fps below 55 on the RTX at
DPR 1*. The median of the three runs is **59.8 fps**. Nothing qualifies, so no
rendering knob was changed — not the tileset's screen-space error, not MSAA, not
one layer budget. The app is already at its own frame ceiling on this hardware.

### The Intel rows are the whole story of "glitchy"

The same build, same scene, same camera path on the integrated GPU: **7.4 fps,
~132 ms per frame, 54-60 stalls per 8-second sample.** An 8x difference, and the
app is identical in both. The complaint was never application inefficiency; it
was which adapter was rendering.

This is exactly why the Intel numbers were not allowed to justify tuning.
Lowering tile detail or anti-aliasing would have "improved" the 7.4 fps case
while permanently degrading the image on the GPU that was already hitting 60.

### When the discrete GPU disappears

It has happened repeatedly on this machine, and it does not announce itself —
Chrome falls back to Intel silently and the app simply feels broken:

```
Get-PnpDevice -Class Display  ->  NVIDIA ... : Error
DEVPKEY_Device_ProblemCode    ->  43   (CM_PROB_FAILED_POST_START)
nvidia-smi                    ->  "couldn't communicate with the NVIDIA driver"
```

`pnputil /restart-device` reports success and leaves the code at 43. A **full
power-down** cleared it (verified: problem code 0, driver 616.56 responding).
`--force-high-performance-gpu` cannot select an adapter Windows has marked
failed, so the flag is no defence against this.

**Check the NVIDIA row reads `OK` before investigating any performance
complaint, and confirm the harness reports `"gpu": "NVIDIA"` or discard the run.**

## Tried and reverted

Nothing. No rendering change was justified by a measurement — see the verdict
above. This section exists so that a future change without a number in it looks
as out of place as it is.

## Not a deficit

`vite preview` already gzips everything it serves, including the two large
`.geojsonl` packs, whose extension has no MIME entry and so falls through to
`text/plain`:

| Asset | On disk | On the wire | Encoding |
|---|---|---|---|
| `datacenters-*.geojsonl` | 2,561,978 | 623,082 | gzip |
| `dams-*.geojsonl` | 730,280 | 199,398 | gzip |
| `index-*.js` | 1,370,453 | 423,209 | gzip |
| `regions-*.js` | 1,987,147 | 683,530 | gzip |
| `index-*.css` | 190,271 | 32,926 | gzip |

Hashed assets also carry `Cache-Control: public, max-age=31536000, immutable`.
A middleware to force a compressible content type on `.geojsonl` was planned and
then **not written**, because the measurement showed it would have changed
nothing.

## Image size and cold start

The runtime image carried `node_modules/cesium` and `node_modules/@cesium` —
102 MB of a 148 MB `node_modules` — despite nothing importing them after the
build. A module resolve hook around `vite preview`, with the server up and
serving, records ten packages loading and neither Cesium package among them.

| Image | Compressed layers + config |
|---|---|
| v13, before | 154,906,297 B (147.7 MB) |
| v14, after | 122,759,477 B (117.1 MB) |

**30.7 MB smaller, 20.8%.** On a service that scales to zero, image size is
startup latency: every first visit after an idle period pays a full pull.

Cold start, measured on v14 after a genuine overnight scale-to-zero window:

| Hit | Time to first byte |
|---|---|
| 1st, cold (image pull + Node boot + config evaluation) | **2.55 s** |
| 2nd, warm | 0.49 s |
| 3rd, warm | 0.23 s |

So an idle-period visitor waits about **2.5 seconds** for the first byte, and
roughly a quarter second thereafter. There is **no before/after comparison**:
v13's cold start was never measured, so the prune's effect on this number is
unknown rather than zero. What is known is the input — 30.7 MB less to pull.

Eliminating the cold start entirely means keeping an instance warm, which is a
standing cost (~$10-15/month) and was declined in favour of a smaller image.
