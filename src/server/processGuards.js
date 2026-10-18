/**
 * Keep the server alive through faults, and shut it down cleanly on request.
 *
 * Cloud Run runs one process per instance and restarts it when it exits, so a
 * single unhandled rejection anywhere across 19 proxy routes takes the whole
 * app down - and `restartPolicyType: on-failure` then hides the cause behind a
 * restart loop. Node's default for an unhandled rejection is to terminate, so
 * "one upstream returned something unexpected" and "the service is down" are
 * the same event until this is installed.
 *
 * SIGTERM matters for the opposite reason: Cloud Run sends it before every
 * scale-down and every deploy. Ignoring it drops in-flight requests during a
 * routine release, which reads to a user as random failures at deploy time.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */

const INSTALLED = Symbol.for('gev.processGuards.installed');

/**
 * @param {{proc?: NodeJS.Process, log?: (msg: string) => void, onShutdown?: () => Promise<void> | void}} options
 */
export function installProcessGuards({
  proc = process,
  log = console.error,
  onShutdown,
} = {}) {
  // Vite restarts the dev server in-process on config change while module state
  // survives; without this each reload stacks another set of handlers.
  if (proc[INSTALLED]) return proc;
  proc[INSTALLED] = true;

  const describe = (error) =>
    error instanceof Error ? `${error.message}\n${error.stack}` : String(error);

  proc.on('unhandledRejection', (reason) => {
    log(`[gev] unhandled rejection (kept alive): ${describe(reason)}`);
  });

  proc.on('uncaughtException', (error) => {
    // Deliberately non-fatal to match the rejection case: one bad request
    // handler should degrade a layer, not end the instance.
    log(`[gev] uncaught exception (kept alive): ${describe(error)}`);
  });

  const shutdown = async (signal) => {
    log(`[gev] ${signal} received, shutting down`);
    try {
      await onShutdown?.();
    } catch (error) {
      // Never let a failed cleanup wedge the shutdown - Cloud Run SIGKILLs
      // shortly after SIGTERM regardless.
      log(`[gev] shutdown hook failed: ${describe(error)}`);
    }
    proc.exitCode = 0;
  };

  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));

  return proc;
}
