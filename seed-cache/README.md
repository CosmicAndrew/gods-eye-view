# Seeded TLE cache

Orbital elements for the satellite layer, copied from a warm `.gev-cache` and
baked into the deployment image.

**Why this exists:** celestrak.org - the only source the proxy has - went
globally unreachable (`ECONNREFUSED` from three independent networks, and no
working mirror: celestrak.com is the same host, tle.ivanstanojevic.me returns
508, api.keeptrack.space returns 410). A fresh container has no disk cache, so
every `/api/celestrak/*` request answered 502 and the satellite layer rendered
nothing. The proxy already serves stale on upstream failure; it just had
nothing stale to serve.

**Why stale data is acceptable here:** SGP4 propagation degrades gradually, not
sharply - day-old elements still place satellites usefully. This is a seed, not
a pin: the proxy overwrites each group with fresh data the moment celestrak
answers again.

**Refresh:** with celestrak reachable, run the app, let the satellite layer
load, then `cp .gev-cache/celestrak-*.json seed-cache/`.
