import { lookup } from "node:dns/promises";

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) {
    return true;
  }
  if (host.includes(":")) {
    const lowered = host.toLowerCase();
    if (lowered.startsWith("fc") || lowered.startsWith("fd") || lowered === "::" || lowered.startsWith("::ffff:")) {
      return true;
    }
  }
  const octets = ipv4Octets(host);
  if (octets) {
    return isPrivateIpv4(octets);
  }
  return false;
}

export function assertPublicHttpsUrl(raw: string, label = "url"): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EndpointError(`${label} is required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EndpointError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new EndpointError(`${label} must be https`);
  }
  if (parsed.username || parsed.password) {
    throw new EndpointError(`${label} must not include credentials`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new EndpointError(`${label} must not target a private or local network`);
  }
  return parsed;
}


export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const systemLookup: HostLookup = (hostname) => lookup(hostname, { all: true });

/**
 * Refuses a host that resolves to a private or local address now, whatever its name: a public
 * name may point inward later. A name this process cannot resolve is left to the proxy or
 * firewall in front of it.
 */
export async function assertPublicHost(hostname: string, resolve: HostLookup = systemLookup): Promise<void> {
  if (isBlockedHost(hostname)) {
    throw new EndpointError(`${hostname} is a private or local address`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return;
  }
  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new EndpointError(`${hostname} resolves to a private or local address`);
    }
  }
}
