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
earthquakes, satellites, rocket-launches. Camera rotating for the whole sample.

| Run | GPU | fps | median ms | p95 ms | worst ms | stalls >100 ms | throttled |
|---|---|---|---|---|---|---|---|
| A | Intel | 7.5 | 131.2 | 155.4 | 203.8 | 60 | false |
| B | Intel | 7.3 | 132.8 | 187.0 | 292.8 | 54 | false |

`throttled: false` on both, so these are real samples, not a background-tab
artifact. **This is what "very glitchy" is**: a median frame of ~132 ms with
more than fifty stalls over 100 ms in an eight-second window.

An earlier single run on the same build reported 16.5 fps. Its GPU field was not
captured, so it is recorded here only as evidence of run-to-run spread, not as a
second data point.

## The RTX column is missing, and why

The discrete GPU **fell off the PCI bus during this session**. It was healthy at
session start and later reported:

```
Get-PnpDevice -Class Display  →  NVIDIA GeForce RTX 3080 Ti Laptop GPU : Error
DEVPKEY_Device_ProblemCode    →  43   (CM_PROB_FAILED_POST_START)
nvidia-smi                    →  "couldn't communicate with the NVIDIA driver"
```

`pnputil /restart-device` reported success and the device stayed at problem 43,
so the fault survives a device restart. **A full power-down is required** — a
warm reboot does not re-enumerate the bus on this machine.

Both rows above were therefore rendered by the Intel iGPU even though Chrome was
launched with `--force-high-performance-gpu`: the flag cannot select an adapter
that Windows has marked failed. **No RTX baseline was captured, and no Intel run
is recorded as one.**

Consequence for tuning: the deficit rule (median motion fps < 55 on the RTX at
DPR 1) has no RTX measurement to test against, so no rendering knob was changed
on the strength of these numbers. Tuning against Intel-only data risks trading
away quality on the adapter the app is normally driven by.

## What to do when the RTX is back

1. Full shutdown (not restart), then `Get-PnpDevice -Class Display` must read
   `OK` for the NVIDIA row before anything else. This check comes first every
   time: a dead discrete GPU looks exactly like a slow application.
2. Re-run the table above; the `gpu` field must read `NVIDIA` or the run is void.
3. Only then apply the deficit rule and, if a scene is under it, work the ranked
   candidates in `docs/plans/` — tileset `maximumScreenSpaceError` first, then
   `msaaSamples`, then per-layer budgets, each with its own before/after row.

## Tried and reverted

Nothing yet — no rendering change has been justified by a measurement.

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
