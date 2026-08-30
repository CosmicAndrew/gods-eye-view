# God's Eye View - container image for a private, password-gated deployment.
#
# The app is served by `vite preview`, not a separate server: its entire API
# surface (19 /api/* routes) is Vite plugin middleware defined in
# vite.config.js. That is also why devDependencies are installed and kept -
# vite itself is the runtime here, not just a build tool.

# ── build stage ───────────────────────────────────────────────────────────────
# Split from the runtime stage so puppeteer and sharp - devDependencies used
# only by the scripts/qa-*.mjs harnesses - never reach the shipped image. On
# Cloud Run the image is pulled before a cold instance can serve, so its size
# is startup latency, not just disk.
FROM node:24-slim AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    CI=true

WORKDIR /app

COPY package.json package-lock.json ./
# `--include=dev` because NODE_ENV=production would otherwise omit vite, which
# is the runtime here. The retry settings are not boilerplate: this install
# pulls ~270 packages including Cesium, and a plain `npm ci` died on ECONNRESET
# partway through on a flaky connection.
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && npm ci --include=dev

COPY . .

# GOOGLE_MAPS_API_KEY is injected into the browser bundle by vite's `define`,
# so it has to exist at BUILD time - supplying it only at runtime yields an
# image whose globe silently fails to authenticate. On Railway, set it as a
# service variable and it is passed through as a build arg.
# Note this bakes the key into an image layer: keep the image private, and
# restrict the key to the deploy domain + the four APIs it needs.
ARG GOOGLE_MAPS_API_KEY
ARG CESIUM_ION_TOKEN
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY \
    CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN
RUN npm run build

# Drop the QA-only packages by name rather than pruning devDependencies.
# `npm ci --omit=dev` removes vite too - vite IS the runtime here, it serves the
# app and hosts every /api route - and reinstalling it under NODE_ENV=production
# does not bring it back, which fails the container at startup with
# "Cannot find package 'vite'". puppeteer and sharp are the bulk of the weight
# and are used only by scripts/qa-*.mjs, which never run in the image.
RUN rm -rf \
      node_modules/puppeteer \
      node_modules/puppeteer-core \
      node_modules/@puppeteer \
      node_modules/sharp \
      node_modules/@img \
      node_modules/chromium-bidi \
      node_modules/devtools-protocol \
 && npm cache clean --force

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0

WORKDIR /app

# vite.config.js imports from src/, so the source tree ships too - it is small
# next to node_modules and is what defines the API surface.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.js ./vite.config.js
COPY --from=build /app/index.html ./index.html
COPY --from=build /app/src ./src
COPY --from=build /app/config ./config
COPY --from=build /app/public ./public

# Seed the proxy's disk cache with orbital elements. celestrak.org is globally
# unreachable and has no working mirror, so a fresh container answered every
# /api/celestrak/* with 502 and the satellite layer rendered nothing - the
# proxy serves stale on upstream failure, but had nothing stale to serve. The
# moment celestrak answers again these are overwritten with fresh data. See
# seed-cache/README.md.
COPY --from=build /app/seed-cache/celestrak-*.json ./.gev-cache/

# The port is read from $PORT at runtime (see the `preview` block in vite.config.js).
EXPOSE 4173

# Exec vite directly rather than through `npx`. As PID 1, npx does not forward
# SIGTERM to its child, so Cloud Run's shutdown signal never reaches the server
# and every scale-down and deploy drops in-flight requests instead of draining.
CMD ["node", "node_modules/vite/bin/vite.js", "preview"]
