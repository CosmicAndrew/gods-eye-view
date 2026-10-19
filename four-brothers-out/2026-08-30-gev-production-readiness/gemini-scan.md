I will now begin the production-readiness review. I will first read the specified files to understand the system's architecture and identify potential gaps.
Based on the provided files, here is a prioritized list of production-readiness gaps for the `gods-eye-view` application.

### 1. High-Severity Gaps: Process Stability and Resource Leaks

These issues present a direct risk of the container crashing, leading to service interruptions and poor reliability.

*   **`vite.config.js` (process-wide): No Unhandled Rejection Handler**
    *   **Gap:** The Node.js process lacks a global handler for unhandled promise rejections (`process.on('unhandledRejection', ...)`). Numerous asynchronous operations (network requests, disk I/O) are performed. While many promises have `.catch()` handlers, any single unhandled rejection will terminate the entire process.
    *   **Consequence:** A transient network error or unexpected API response could crash the container. The `on-failure` restart policy will mask the root cause, leading to a cycle of crashes and cold starts ("crash-looping").

*   **`vite.config.js:160`, `403`, `1869`: Unbounded In-Memory Caches**
    *   **Gap:** Several in-memory caches are implemented as standard `Map` objects with no eviction policy or size limit. Notably: `_overpassCache` (line 160), `_routeCache` (line 403), `_aisStreamVessels` (line 1869), and `_aisStreamStatic` (line 1871).
    *   **Consequence:** These caches will grow with application use, consuming memory indefinitely. On a memory-constrained platform like Cloud Run, this will eventually lead to memory exhaustion, causing the container to be terminated. This is a slow-burning but inevitable memory leak.

*   **`vite.config.js:156`, `1986`, `2211`: Ephemeral Filesystem Used for Persistence**
    *   **Gap:** Multiple proxies (Overpass, CelesTrak, TomTom, FIRMS, etc.) use a local `.gev-cache` directory for a persistent disk cache. The `Dockerfile` even pre-seeds this cache.
    *   **Consequence:** Cloud Run's filesystem is ephemeral and stored in RAM. This implementation defeats the purpose of a persistent cache (it will be wiped on every instance restart) and consumes the instance's memory, not a separate disk volume. This puts unnecessary memory pressure on the container and can accelerate memory-exhaustion crashes.

### 2. Medium-Severity Gaps: Availability and Reliability

These issues affect the application's ability to handle deployments, scaling, and traffic routing gracefully.

*   **`vite.config.js` (process-wide) & `Dockerfile:89`: No Graceful Shutdown (SIGTERM Handling)**
    *   **Gap:** The application does not handle the `SIGTERM` signal. Cloud Run sends `SIGTERM` to containers before shutting them down for scaling or new deployments. The `CMD ["npx", ...]` in the Dockerfile may also prevent signals from being correctly passed to the Vite process.
    *   **Consequence:** In-flight requests will be terminated abruptly. This can corrupt data, leave client connections hanging, and cause errors for users during routine deployments.

*   **`vite.config.js` (server-wide): Missing Health and Readiness Endpoints**
    *   **Gap:** The Vite server does not expose any health check endpoints (e.g., `/healthz` for liveness, `/readyz` for readiness).
    *   **Consequence:** Cloud Run has no way to verify if the application is ready to accept traffic or if a running instance has become unresponsive. It may route traffic to a container that is still initializing (causing errors) or fail to restart a container that is stuck but not crashed.

*   **`vite.config.js:1888`: Inconsistent Upstream Request Timeouts**
    *   **Gap:** Some upstream `fetch` calls implement timeouts (e.g., CelesTrak, TomTom), but others do not. The `getOpenSkyToken` function (line 1888) makes a `fetch` call with no timeout signal.
    *   **Consequence:** An unresponsive upstream API (like OpenSky's auth service) can cause a request handler to hang indefinitely, consuming a connection and holding resources until the client times out. This can lead to connection pool exhaustion under load.

### 3. Low-Severity Gaps: Observability and Resilience

These issues will make the application difficult to debug and operate in a production environment.

*   **`vite.config.js` (file-wide): Unstructured Logging**
    *   **Gap:** Logging is performed using `console.log` and `console.warn`. These logs are unstructured, plain-text strings.
    *   **Consequence:** In a production environment like Google Cloud Logging, unstructured logs are difficult to query, filter, and alert on. It becomes nearly impossible to trace a single request's lifecycle or analyze error patterns effectively.
