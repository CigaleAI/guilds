import { afterEach } from "node:test";
import { installConnectors, replaceInstalledConnector } from "../../src/connectors/index.js";
import type { ConnectorRegistry } from "../../src/connectors/registry.js";

/** Runs the box on `registry`: each of its connectors in place of the installed one of the same slug, or beside them. */
export function runConnectors(registry: ConnectorRegistry): void {
  for (const entry of registry.entries()) {
    replaceInstalledConnector(entry);
  }
}

/** Puts core's connectors back as the box's after each test of the file that calls it. */
export function restoreConnectorsAfterEach(): void {
  afterEach(() => {
    installConnectors([]);
  });
}
