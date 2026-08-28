# God's Eye View - container image for a private, password-gated deployment.
#
# The app is served by `vite preview`, not a separate server: its entire API
# surface (19 /api/* routes) is Vite plugin middleware defined in
# vite.config.js. That is also why devDependencies are installed and kept -
# vite itself is the runtime here, not just a build tool.

FROM node:24-slim

# Chromium is only needed by the scripts/qa-*.mjs harnesses, which never run in
# the image. Left unset, puppeteer's postinstall downloads ~150MB during build.
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

# Bind all interfaces so the platform can route to the container. The port is
# read from $PORT at runtime (see the `preview` block in vite.config.js).
ENV HOST=0.0.0.0
EXPOSE 4173

CMD ["npx", "vite", "preview"]
