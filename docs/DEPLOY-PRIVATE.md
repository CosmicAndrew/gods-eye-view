# Private deployment (password-gated)

How to run this on a host you can reach from anywhere, without handing your
metered API keys to the internet.

## Why a Node host, and not static hosting

The app has no separate backend: all 19 `/api/*` routes are Vite plugin
middleware in `vite.config.js`. So the deployment runs `vite preview`, and a
static host (here.now, Netlify drop, S3, GitHub Pages) cannot serve it. On
static hosting you would get the globe and the bundled datasets, and lose every
live layer plus voice — `/api/realtime/token` mints the OpenAI session with the
server's own key, and there is no server to mint it.

## Two facts that decide the configuration

**The Google key is a build-time input.** `vite.config.js` injects it into the
browser bundle through `define`, so it must be present when `npm run build`
runs. Supplying it only at runtime produces an image whose globe fails to
authenticate, with no error beyond a 400 from `tile.googleapis.com`. The
`Dockerfile` takes it as an `ARG` for exactly this reason.

**The OpenAI key is runtime-only and must stay that way.** It never enters the
bundle. Verify after any change:

```bash
grep -rl "$OPENAI_API_KEY" dist/   # must print nothing
```

## Deploy to Railway

```bash
npm i -g @railway/cli
railway login          # opens a browser
railway init           # or: railway link, for an existing project
```

Set the variables (Railway dashboard → Variables, or `railway variables --set`):

| Variable | Required | Notes |
|---|---|---|
| `GEV_AUTH_USER` | **yes** | Any username. Without both auth vars the gate is uninstalled and the deploy is public. |
| `GEV_AUTH_PASSWORD` | **yes** | Use a long random value. |
| `GOOGLE_MAPS_API_KEY` | **yes** | Build **and** runtime. Globe, geocoding, places, street view. |
| `OPENAI_API_KEY` | for voice | Runtime only. Never prefix with `VITE_`. |
| `OPENSKY_AUTH_MODE` | recommended | `anon` — aircraft work keyless. |
| `GEV_RATELIMIT_OPENAI_PER_MIN` | recommended | e.g. `30`. Per-IP, process-local; not a billing cap. |
| `GEV_RATELIMIT_GOOGLE_PER_MIN` | recommended | e.g. `60`. |
| `GEV_ALLOWED_HOSTS` | custom domain only | Comma-separated. `RAILWAY_PUBLIC_DOMAIN` is picked up automatically. |
| `CESIUM_ION_TOKEN`, `FIRMS_MAP_KEY`, `AISSTREAM_API_KEY`, `TOMTOM_API_KEY` | optional | Free tiers. Layers degrade gracefully without them. |

Then:

```bash
railway up
```

`HOST=0.0.0.0` is set in the image; `PORT` comes from the platform and is read
by the `preview` block in `vite.config.js`.

> **No healthcheck path is configured on purpose.** With the auth gate armed,
> every path including `/` answers `401`, so a healthcheck would mark a healthy
> deploy as failed. Railway falls back to port detection.

## Verify the deployment

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/                    # 401
curl -s -o /dev/null -w '%{http_code}\n' -u user:pass https://<domain>/       # 200
curl -s -o /dev/null -w '%{http_code}\n' -u user:pass https://<domain>/api/realtime/token  # 200
```

The first must be `401`. If it is `200`, the gate is not armed — the browser
bundle, and the Google key inside it, are public. Fix before going further.

## Cost exposure

Anyone holding the password can spend real money: OpenAI voice sessions (the app
caps each at $5, warns at $2) and Google tile requests. The password is the
control that matters; the rate limits only blunt a runaway loop.

Set provider-side budgets too, because neither the app nor the rate limiter can
stop spend: Google Cloud → Billing → Budgets & alerts, plus per-API quota caps
under APIs & Services → Quotas, and OpenAI → Settings → Limits.

**The Google key is baked into an image layer** by the build. Keep the image
registry private, restrict the key to the four APIs it needs, and prefer a key
dedicated to this deployment so it can be rotated without touching anything else.
