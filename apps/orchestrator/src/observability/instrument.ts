import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { initSentry } from "./sentry.js";

initSentry();

if (Sentry.getClient()) {
  try {
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
