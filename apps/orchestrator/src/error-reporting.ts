import { ERROR_REPORTING, integrationValue } from "./instance/integrations.js";
import { initSentry } from "./observability/sentry.js";

/** Starts Sentry for this process when the box has error reporting on; a process entry calls it first. */
export function startErrorReporting(): void {
  initSentry({ dsn: integrationValue(ERROR_REPORTING, "SENTRY_DSN") });
}
