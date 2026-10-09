import { fileURLToPath } from "node:url";
import { ConnectorRegistry, folderEntry, type ConnectorEntry } from "./registry.js";
import alchemyManifest from "./alchemy/connector.json" with { type: "json" };
import alchemy from "./alchemy/adapter.js";
import cigaleManifest from "./cigale/connector.json" with { type: "json" };
import coingeckoManifest from "./coingecko/connector.json" with { type: "json" };
import coingecko from "./coingecko/adapter.js";
import dexpaprikaManifest from "./dexpaprika/connector.json" with { type: "json" };
import dexpaprika from "./dexpaprika/adapter.js";
import driveManifest from "./drive/connector.json" with { type: "json" };
import drive from "./drive/adapter.js";
import etherscanManifest from "./etherscan/connector.json" with { type: "json" };
import githubManifest from "./github/connector.json" with { type: "json" };
import gmailManifest from "./gmail/connector.json" with { type: "json" };
import gmail from "./gmail/adapter.js";
import notionManifest from "./notion/connector.json" with { type: "json" };
import openseaManifest from "./opensea/connector.json" with { type: "json" };
import opensea from "./opensea/adapter.js";
import qontoManifest from "./qonto/connector.json" with { type: "json" };
import qonto from "./qonto/adapter.js";
import sentryManifest from "./sentry/connector.json" with { type: "json" };
import tavilyManifest from "./tavily/connector.json" with { type: "json" };
import tavily from "./tavily/adapter.js";
import twitterapiioManifest from "./twitterapiio/connector.json" with { type: "json" };
import twitterapiio from "./twitterapiio/adapter.js";
import xManifest from "./x/connector.json" with { type: "json" };
import x from "./x/adapter.js";

function folder(slug: string): string {
  return fileURLToPath(new URL(`./${slug}/`, import.meta.url));
}

/** The connectors core ships, one folder each. */
export const CORE_CONNECTORS: readonly ConnectorEntry[] = [
  folderEntry(notionManifest, {}, folder("notion")),
  folderEntry(gmailManifest, gmail, folder("gmail")),
  folderEntry(driveManifest, drive, folder("drive")),
  folderEntry(sentryManifest, {}, folder("sentry")),
  folderEntry(githubManifest, {}, folder("github")),
  folderEntry(cigaleManifest, {}, folder("cigale")),
  folderEntry(coingeckoManifest, coingecko, folder("coingecko")),
  folderEntry(alchemyManifest, alchemy, folder("alchemy")),
  folderEntry(openseaManifest, opensea, folder("opensea")),
  folderEntry(etherscanManifest, {}, folder("etherscan")),
  folderEntry(xManifest, x, folder("x")),
  folderEntry(twitterapiioManifest, twitterapiio, folder("twitterapiio")),
  folderEntry(qontoManifest, qonto, folder("qonto")),
  folderEntry(dexpaprikaManifest, dexpaprika, folder("dexpaprika")),
  folderEntry(tavilyManifest, tavily, folder("tavily")),
];

/** Core's connectors. */
export const CONNECTORS = new ConnectorRegistry(CORE_CONNECTORS);

let installed = CONNECTORS;

/** The connectors this box runs: core's, then an extension's. */
export function installedConnectors(): ConnectorRegistry {
  return installed;
}

/** Appends an extension's connectors to core's. A slug core already has fails. */
export function installConnectors(entries: readonly ConnectorEntry[]): ConnectorRegistry {
  installed = CONNECTORS.with(entries);
  return installed;
}

/**
 * Puts a connector installed at runtime (a registry connector with code) into the installed set,
 * in place of its previous version. Calls already running keep the adapter they started with.
 */
export function replaceInstalledConnector(entry: ConnectorEntry): ConnectorRegistry {
  installed = installed.replacing(entry);
  return installed;
}

/** Takes a connector installed at runtime out of the installed set. */
export function removeInstalledConnector(slug: string): ConnectorRegistry {
  installed = installed.without(slug);
  return installed;
}
