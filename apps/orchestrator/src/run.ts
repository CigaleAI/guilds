import { createServer } from "./compose.js";
import type { AppConfig } from "./config/index.js";
import type { ServerExtension } from "./extension.js";
import { configureLogging } from "./observability/log.js";
import { flushSentry, sentryEnabled } from "./observability/sentry.js";

/**
 * Runs the server as this process: builds it with the edition's extensions, listens, and shuts
 * down on a signal or a fatal error. An entry point loads its configuration and calls this.
 */
export async function runServer(
  config: AppConfig,
  options: { extensions?: ServerExtension[] } = {},
): Promise<void> {
  const log = configureLogging();
  log.info(sentryEnabled() ? "sentry enabled" : "sentry disabled", { operation: "sentry.init" });

  let closing = false;
  let stop: () => Promise<void> = async () => {};

  function onFatal(operation: string, error: unknown): void {
    log.error(error instanceof Error ? error.message : String(error), { operation }, error);
  }

  async function crash(operation: string, error: unknown): Promise<void> {
    onFatal(operation, error);
    await flushSentry();
    await stop();
    process.exit(1);
  }

  process.on("unhandledRejection", (reason) => {
    void crash("process.unhandled", reason);
  });
  process.on("uncaughtException", (error) => {
    void crash("process.uncaught", error);
  });

  const server = await createServer(config, options);

  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
    await flushSentry();
  };
  stop = shutdown;

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  await server.app.listen({ host: config.host, port: config.port });
  log.info("listening", { operation: "http.listen" });
}
