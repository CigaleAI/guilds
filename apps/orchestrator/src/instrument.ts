import * as Sentry from "@sentry/node";
import { eventLoopBlockIntegration } from "@sentry/node-native";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { startErrorReporting } from "./error-reporting.js";
import { EVENT_LOOP_STALL_MS } from "./observability/runtime.js";

const EVENT_LOOP_STALLS_PER_HOUR = 10;

startErrorReporting();

if (Sentry.getClient()) {
  try {
    // A watchdog thread that sends the main thread's stack when the event loop stalls.
    Sentry.addIntegration(
      eventLoopBlockIntegration({
        threshold: EVENT_LOOP_STALL_MS,
        maxEventsPerHour: EVENT_LOOP_STALLS_PER_HOUR,
      }),
    );
    Sentry.addIntegration(nodeProfilingIntegration());
    Sentry.addIntegration(
      Sentry.fastifyIntegration({
        shouldHandleError: () => false,
      }),
    );
  } catch {
    /* profiling is optional; capture still works */
  }
}
