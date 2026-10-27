import { pathToFileURL } from "node:url";
import { loadToolConfig } from "../config/index.js";
import { connect } from "../db/client.js";
import { registryClient, type RegistryClient } from "../registry/client.js";
import { codeTierRoot, connectorsRoot } from "../registry/code.js";
import { RegistryError } from "../registry/index.js";
import { installConnector, listConnectors, removeConnector, updateConnectors } from "../registry/install.js";
import type { Queryable } from "../db/pg.js";

export const USAGE = `usage: connector install <slug>[@version] [--unverified] [--experimental]
       connector remove <slug>
       connector list
       connector update [slug] [--unverified] [--experimental]`;

const FLAGS = new Set(["--unverified", "--experimental"]);
const SERVES = "; the running server serves its code after Admin → Reload connectors";

function needClient(client: RegistryClient | null): RegistryClient {
  if (client === null) {
    throw new RegistryError("the box is offline: REGISTRY_URL is set empty", 409);
  }
  return client;
}

/** Runs one `connector` command against a box's database and registry; returns the lines it prints. */
export async function connectorCommand(
  argv: readonly string[],
  deps: { db: Queryable; client: RegistryClient | null; env?: NodeJS.ProcessEnv },
): Promise<string[]> {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const [command, target, ...rest] = argv.filter((arg) => !arg.startsWith("--"));
  const unverified = flags.has("--unverified");
  const experimental = flags.has("--experimental");
  if (rest.length || [...flags].some((flag) => !FLAGS.has(flag))) {
    throw new RegistryError(USAGE, 400);
  }
  switch (command) {
    case "install": {
      if (!target) {
        throw new RegistryError(USAGE, 400);
      }
      const [slug = "", version] = target.split("@");
      const { row, code } = await installConnector(deps.db, needClient(deps.client), slug, {
        ...(version ? { version } : {}),
        unverified,
        experimental,
        codeRoot: codeTierRoot(deps.env),
      });
      const marks = [row.verified ? "" : "unverified", row.experimental ? "experimental" : ""].filter(Boolean);
      return [`installed ${slug}@${String(row.version)}${marks.length ? ` (${marks.join(", ")})` : ""}${code ? SERVES : ""}`];
    }
    case "remove": {
      if (!target) {
        throw new RegistryError(USAGE, 400);
      }
      await removeConnector(deps.db, target, connectorsRoot(deps.env));
      return [`removed ${target}`];
    }
    case "list": {
      if (target) {
        throw new RegistryError(USAGE, 400);
      }
      const index = deps.client ? await deps.client.index() : null;
      return (await listConnectors(deps.db, index)).map((row) =>
        [
          row.slug,
          row.source,
          row.version || "-",
          row.enabled ? "on" : "off",
          row.verified ? "verified" : "unverified",
          ...(row.experimental ? ["experimental"] : []),
          ...(row.latest && row.latest !== row.version ? [`update ${row.latest}`] : []),
        ].join("\t"),
      );
    }
    case "update": {
      const moved = await updateConnectors(deps.db, needClient(deps.client), {
        ...(target ? { slug: target } : {}),
        unverified,
        experimental,
        codeRoot: codeTierRoot(deps.env),
        connectorsRoot: connectorsRoot(deps.env),
      });
      return moved.length
        ? moved.map((item) => `updated ${item.slug} ${item.from || "-"} -> ${item.to}${item.code ? SERVES : ""}`)
        : ["up to date"];
    }
    default:
      throw new RegistryError(USAGE, 400);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadToolConfig();
  const database = await connect(config.databaseUrl);
  try {
    const lines = await connectorCommand(process.argv.slice(2), {
      db: database.pool,
      client: registryClient(),
    });
    for (const line of lines) {
      console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
