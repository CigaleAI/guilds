import { fileURLToPath } from "node:url";
import { CONNECTORS } from "../../src/connectors/index.js";
import { folderEntry } from "../../src/connectors/registry.js";
import adapter from "./quotes/adapter.js";
import manifest from "./quotes/connector.json" with { type: "json" };

/** A test connector with settings, a searchable setting, and a State hook. */
export const QUOTES = folderEntry(manifest, adapter, fileURLToPath(new URL("./quotes", import.meta.url)));

/** Core's connectors with Quotes beside them. */
export const WITH_QUOTES = CONNECTORS.with([QUOTES]);
