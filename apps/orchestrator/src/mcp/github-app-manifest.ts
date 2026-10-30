import { storeInstanceKey, type InstanceKeyServices } from "../connectors/instance-keys.js";
import type { Queryable } from "../db/pg.js";
import {
  APP_NAME_MAX,
  convertManifestCode,
  githubAppManifest,
  manifestAction,
  type ConvertedGithubApp,
  type GithubAppManifest,
} from "../github/manifest.js";
import { GITHUB_APP } from "../instance/integrations.js";
import { InstanceKeyError } from "../instance/keys.js";
import { newState } from "../oauth/index.js";
import { writeLog } from "../observability/log.js";

/** How long a started manifest flow waits for GitHub's redirect. */
const PENDING_MS = 20 * 60 * 1000;
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/** A started flow: the admin who started it, where to send them back, and when it lapses. */
type PendingManifest = { userId: string; returnTo: string | null; expiresAt: number };

/** The addresses a manifest's URLs point at: the box's, and the one the admin's request came in on. */
export type ManifestAddresses = { baseUrl: string; requestOrigin: string };

/**
 * A GitHub App registration the instance admin asks for: its name and the organisation it belongs
 * to as sent (empty when left out), where to come back to, and the addresses of its URLs.
 */
export type ManifestRequest = ManifestAddresses & {
  name: string;
  owner: string;
  returnTo: string | undefined;
};

/** What the browser posts to GitHub, and the state that ties GitHub's redirect back to this flow. */
export type ManifestStarted = { action: string; manifest: GithubAppManifest; state: string };

/** What GitHub's redirect carries, and the state the browser's cookie holds. */
export type ManifestCallback = { code: string; state: string; cookieState: string };

/** Why a callback did not store the App: the state did not prove the flow, GitHub refused the code, or the store failed. */
export type ManifestFailure = "state" | "conversion" | "store";

/** Where the admin goes once the App is stored (null for the admin page), or why it was not. */
export type ManifestOutcome = { returnTo: string | null } | { failure: ManifestFailure };

/** A path on this app the callback may send the admin back to; never another origin. */
function sameOriginPath(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) {
    return null;
  }
  return path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** The App GitHub returns, in the GitHub App integration's fields. */
function githubAppValues(converted: ConvertedGithubApp): Record<string, string> {
  return {
    app_id: converted.app_id,
    slug: converted.slug,
    private_key: converted.private_key,
    client_id: converted.client_id,
    client_secret: converted.client_secret,
  };
}

/**
 * The box's GitHub App registered from a manifest: each flow the instance admin started here,
 * waiting for GitHub's redirect, whose code is traded for the App and stored for that admin.
 */
export class GithubManifestFlows {
  private readonly pending = new Map<string, PendingManifest>();

  /** Starts a flow for `userId`: refuses a name or an owner GitHub would, and forgets the flows that lapsed. */
  start(request: ManifestRequest, userId: string): ManifestStarted {
    const name = request.name.trim();
    if (name.length > APP_NAME_MAX) {
      throw new InstanceKeyError(`the App name is at most ${APP_NAME_MAX} characters`);
    }
    const owner = request.owner.trim();
    if (owner && !OWNER_PATTERN.test(owner)) {
      throw new InstanceKeyError("owner must be a GitHub organisation login");
    }
    const returnTo = sameOriginPath(request.returnTo);
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
    const state = newState();
    this.pending.set(state, { userId, returnTo, expiresAt: now + PENDING_MS });
    return {
      action: manifestAction(owner || null, state),
      manifest: githubAppManifest(request.baseUrl, request.requestOrigin, name),
      state,
    };
  }

  /** The flow a callback proves it belongs to, spent whether or not it does: its state, its cookie, its time, and a code. */
  private takeFlow(callback: ManifestCallback): PendingManifest | null {
    const { code, state, cookieState } = callback;
    const entry = state ? this.pending.get(state) : undefined;
    if (entry) {
      this.pending.delete(state);
    }
    if (!entry || !cookieState || cookieState !== state || entry.expiresAt <= Date.now() || !code) {
      return null;
    }
    return entry;
  }

  /**
   * Completes the flow GitHub's redirect names: the state proves this browser started it here,
   * and the code is traded for the App, stored for the admin who started it.
   */
  async complete(
    db: Queryable,
    services: InstanceKeyServices,
    callback: ManifestCallback,
  ): Promise<ManifestOutcome> {
    const entry = this.takeFlow(callback);
    if (entry === null) {
      return { failure: "state" };
    }
    let converted;
    try {
      converted = await convertManifestCode(callback.code, { proxyUrl: process.env.ADAPTER_PROXY_URL ?? "" });
    } catch (error) {
      writeLog("warn", `github app manifest conversion failed: ${errorText(error)}`, {
        operation: "instance_keys.github_manifest",
        error_type: errorType(error),
      });
      return { failure: "conversion" };
    }
    try {
      const key = { integration: GITHUB_APP, values: githubAppValues(converted) };
      await storeInstanceKey(db, services, key, entry.userId);
    } catch (error) {
      writeLog("error", `github app could not be stored: ${errorText(error)}`, {
        operation: "instance_keys.github_manifest",
        error_type: errorType(error),
      });
      return { failure: "store" };
    }
    return { returnTo: entry.returnTo };
  }
}
