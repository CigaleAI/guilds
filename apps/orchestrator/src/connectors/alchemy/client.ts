import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, argStr, clipRows, fmtNum, joinParts, rowLimit } from "../format.js";

export const NFT_HOST = "https://{network}.g.alchemy.com/nft/v3";
export const SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2";
export const CHAIN_DEFAULT = "ethereum";
export const PING_OWNER = "0x0000000000000000000000000000000000000000";
export const CHAINS: Record<string, string> = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  bsc: "bnb-mainnet",
  optimism: "opt-mainnet",
  ink: "ink-mainnet",
  robinhood: "robinhood-mainnet",
  solana: "solana-mainnet",
};
export const CHAIN_LIST = Object.keys(CHAINS).join(", ");

export class AlchemyError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AlchemyError";
    this.status = status;
  }
}

export function resolveChain(arguments_: Record<string, unknown>): [string, string] {
  const chain = (argStr(arguments_, "chain", CHAIN_DEFAULT).toLowerCase() || CHAIN_DEFAULT);
  const network = CHAINS[chain];
  if (!network) {
    throw new AlchemyError(`chain must be ${CHAIN_LIST}`);
  }
  return [chain, network];
}

function collectionName(item: Record<string, unknown>): string {
  const collection = item.collection;
  if (collection && typeof collection === "object" && !Array.isArray(collection)) {
    const name = (collection as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return "";
}

function isSpam(item: Record<string, unknown>): boolean {
  const flag = item.isSpam;
  return flag === true || flag === "true";
}

function floorPrice(item: Record<string, unknown>): string {
  const sources = [
    item,
    item.contract && typeof item.contract === "object" && !Array.isArray(item.contract)
      ? (item.contract as Record<string, unknown>)
      : {},
  ];
  for (const source of sources) {
    for (const key of ["openSeaMetadata", "openseaMetadata"]) {
      const meta = source[key];
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const price = (meta as { floorPrice?: unknown }).floorPrice;
        if (price !== null && price !== undefined && price !== "") {
          return `floor=${fmtNum(price)}`;
        }
      }
    }
  }
  return "";
}

function tokenLabel(tokenId: unknown, address: unknown): string {
  if (tokenId === null || tokenId === undefined || tokenId === "") {
    return "";
  }
  const text = String(tokenId).trim();
  if (/^\d+$/.test(text)) {
    return `#${text}`;
  }
  if (text.toLowerCase() === String(address ?? "").trim().toLowerCase()) {
    return "";
  }
  return text;
}

function nftRow(item: Record<string, unknown>): string {
  const contract =
    item.contract && typeof item.contract === "object" && !Array.isArray(item.contract)
      ? (item.contract as Record<string, unknown>)
      : {};
  const tokenId = item.tokenId;
  const address = contract.address ?? item.contractAddress;
  const token = tokenLabel(tokenId, address);
  const tokenType = item.tokenType ?? contract.tokenType;
  const balance = item.balance;
  const collection = (typeof contract.name === "string" ? contract.name : "") || collectionName(item);
  let display = item.name;
  if (display && collection && String(display).trim() === String(collection).trim()) {
    display = "";
  }
  const extra: string[] = [];
  if (tokenType) {
    extra.push(String(tokenType).trim());
  }
  if (balance !== null && balance !== undefined && balance !== "" && balance !== "1" && balance !== 1) {
    extra.push(`bal=${fmtNum(balance)}`);
  }
  if (isSpam(item) || isSpam(contract)) {
    extra.push("spam");
  }
  return joinParts(address, contract.symbol, collection, token, display, ...extra);
}

function contractRow(item: Record<string, unknown>): string {
  const extra: string[] = [];
  if (item.tokenType) {
    extra.push(String(item.tokenType).trim());
  }
  if (item.totalSupply !== null && item.totalSupply !== undefined && item.totalSupply !== "") {
    extra.push(`supply=${fmtNum(item.totalSupply)}`);
  }
  if (isSpam(item)) {
    extra.push("spam");
  }
  return joinParts(item.address ?? item.contractAddress, item.symbol, item.name ?? collectionName(item), ...extra);
}

export function formatHoldings(
  payload: Record<string, unknown>,
  options: { owner: string; chain: string; limit?: number },
): string {
  const owned = Array.isArray(payload.ownedNfts) ? payload.ownedNfts : [];
  const total = payload.totalCount;
  const head = joinParts(
    options.owner,
    options.chain,
    `total=${fmtNum(total !== null && total !== undefined ? total : owned.length)}`,
  );
  const rows = owned
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => nftRow(item));
  const body = clipRows(rows.filter(Boolean), options.limit ?? LIST_DEFAULT);
  const parts = [head];
  if (body !== "no results") {
    parts.push(body);
  }
  const pageKey = payload.pageKey;
  if (typeof pageKey === "string" && pageKey.trim()) {
    parts.push(`page=${pageKey.trim()}`);
  }
  return parts.join("\n");
}

export function formatNft(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) {
    return "no results";
  }
  const row = nftRow(payload);
  const floor = floorPrice(payload);
  const parts = [row, floor].filter(Boolean);
  return parts.length ? parts.join("\n") : "no results";
}

export function formatCollection(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) {
    return "no results";
  }
  const row = contractRow(payload);
  const floor = floorPrice(payload);
  const parts = [row, floor].filter(Boolean);
  return parts.length ? parts.join("\n") : "no results";
}

function fromDas(item: Record<string, unknown>): Record<string, unknown> {
  const content =
    item.content && typeof item.content === "object" && !Array.isArray(item.content)
      ? (item.content as Record<string, unknown>)
      : {};
  const metadata =
    content.metadata && typeof content.metadata === "object" && !Array.isArray(content.metadata)
      ? (content.metadata as Record<string, unknown>)
      : {};
  const grouping = Array.isArray(item.grouping) ? item.grouping : [];
  let collectionId = "";
  let collectionTitle = "";
  for (const group of grouping) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      continue;
    }
    const row = group as Record<string, unknown>;
    if (row.group_key !== "collection") {
      continue;
    }
    collectionId = String(row.group_value ?? "").trim();
    const extra = row.collection_metadata;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      const name = (extra as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) {
        collectionTitle = name.trim();
      }
    }
    break;
  }
  const mint = item.id;
  return {
    contract: {
      address: collectionId || mint,
      name: collectionTitle || metadata.name,
      symbol: metadata.symbol,
      tokenType: item.interface,
    },
    tokenId: mint,
    name: metadata.name,
    tokenType: item.interface,
  };
}

function dasHoldings(payload: Record<string, unknown>, limit: number): Record<string, unknown> {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const owned = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => fromDas(item));
  const total = payload.total;
  let pageKey = "";
  let pageN: number;
  try {
    pageN = payload.page !== null && payload.page !== undefined && payload.page !== "" ? Number.parseInt(String(payload.page), 10) : 1;
    if (!Number.isFinite(pageN)) {
      pageN = 1;
    }
  } catch {
    pageN = 1;
  }
  if (owned.length >= limit) {
    pageKey = String(pageN + 1);
  }
  return {
    ownedNfts: owned,
    totalCount: total !== null && total !== undefined ? total : owned.length,
    pageKey,
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `Alchemy HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const detail = (payload as { error?: unknown; message?: unknown }).error
      ?? (payload as { message?: unknown }).message;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const inner = (detail as { message?: unknown; error?: unknown }).message
        ?? (detail as { error?: unknown }).error;
      if (typeof inner === "string" && inner.trim()) {
        return inner.trim();
      }
    }
  }
  return `Alchemy HTTP ${response.status}`;
}

async function getJson(
  network: string,
  path: string,
  params: Record<string, string>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<unknown> {
  const key = apiKey.trim();
  if (!key) {
    throw new AlchemyError("Alchemy API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const url = withQuery(`${NFT_HOST.replace("{network}", network)}/${key}${path}`, params);
  const response = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
  if (response.status >= 400) {
    throw new AlchemyError(await errorDetail(response), response.status);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new AlchemyError("Alchemy returned a non-JSON body");
  }
}

async function das(
  method: string,
  params: Record<string, unknown>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const key = apiKey.trim();
  if (!key) {
    throw new AlchemyError("Alchemy API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(`${SOLANA_RPC}/${key}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.status >= 400) {
    throw new AlchemyError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new AlchemyError("Alchemy returned a non-JSON body");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AlchemyError("Alchemy returned a non-object");
  }
  const error = (payload as { error?: unknown }).error;
  if (error) {
    const message =
      error && typeof error === "object" && !Array.isArray(error)
        ? (error as { message?: unknown }).message || "Alchemy RPC error"
        : String(error);
    throw new AlchemyError(String(message));
  }
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AlchemyError("Alchemy returned a non-object");
  }
  return result as Record<string, unknown>;
}

async function solanaHoldings(
  owner: string,
  options: {
    contract: string;
    pageKey: string;
    limit: number;
    apiKey: string;
    client?: FetchFn;
    proxyUrl?: string;
  },
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    ownerAddress: owner,
    limit: options.limit,
    options: { showFungible: false, showCollectionMetadata: true },
  };
  if (options.contract) {
    params.grouping = ["collection", options.contract];
  }
  if (options.pageKey) {
    const page = Number.parseInt(options.pageKey, 10);
    if (Number.isFinite(page)) {
      params.page = Math.max(1, page);
    } else {
      params.after = options.pageKey;
    }
  } else {
    params.page = 1;
  }
  const method = options.contract ? "searchAssets" : "getAssetsByOwner";
  const payload = await das(method, params, options.apiKey, options);
  return dasHoldings(payload, options.limit);
}

export async function ping(
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<void> {
  await getJson(
    "eth-mainnet",
    "/getNFTsForOwner",
    { owner: PING_OWNER, pageSize: "1", withMetadata: "false" },
    apiKey,
    options,
  );
}

export async function holdingsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const owner = argStr(arguments_, "owner");
  if (!owner) {
    throw new AlchemyError("owner is required");
  }
  const [chain, network] = resolveChain(arguments_);
  const limit = rowLimit(arguments_);
  const contract = argStr(arguments_, "contract");
  const pageKey = argStr(arguments_, "page_key");
  if (chain === "solana") {
    const dasOptions: {
      contract: string;
      pageKey: string;
      limit: number;
      apiKey: string;
      client?: FetchFn;
      proxyUrl?: string;
    } = { contract, pageKey, limit, apiKey: options.apiKey };
    if (options.client !== undefined) {
      dasOptions.client = options.client;
    }
    if (options.proxyUrl !== undefined) {
      dasOptions.proxyUrl = options.proxyUrl;
    }
    const payload = await solanaHoldings(owner, dasOptions);
    return formatHoldings(payload, { owner, chain, limit });
  }
  const params: Record<string, string> = {
    owner,
    withMetadata: "true",
    pageSize: String(limit),
  };
  if (contract) {
    params["contractAddresses[]"] = contract;
  }
  if (pageKey) {
    params.pageKey = pageKey;
  }
  const payload = await getJson(network, "/getNFTsForOwner", params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AlchemyError("Alchemy returned a non-object");
  }
  return formatHoldings(payload as Record<string, unknown>, { owner, chain, limit });
}

export async function nftTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const contract = argStr(arguments_, "contract");
  const tokenId = argStr(arguments_, "token_id");
  const [chain, network] = resolveChain(arguments_);
  if (chain === "solana") {
    const mint = contract || tokenId;
    if (!mint) {
      throw new AlchemyError("contract is required");
    }
    const payload = await das("getAsset", { id: mint }, options.apiKey, options);
    return formatNft(fromDas(payload));
  }
  if (!contract) {
    throw new AlchemyError("contract is required");
  }
  if (!tokenId) {
    throw new AlchemyError("token_id is required");
  }
  const payload = await getJson(
    network,
    "/getNFTMetadata",
    { contractAddress: contract, tokenId },
    options.apiKey,
    options,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AlchemyError("Alchemy returned a non-object");
  }
  return formatNft(payload as Record<string, unknown>);
}

export async function collectionTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const contract = argStr(arguments_, "contract");
  if (!contract) {
    throw new AlchemyError("contract is required");
  }
  const [chain, network] = resolveChain(arguments_);
  if (chain === "solana") {
    const payload = await das("getAsset", { id: contract }, options.apiKey, options);
    const mapped = fromDas(payload);
    return formatCollection(mapped.contract as Record<string, unknown>);
  }
  const payload = await getJson(
    network,
    "/getContractMetadata",
    { contractAddress: contract },
    options.apiKey,
    options,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AlchemyError("Alchemy returned a non-object");
  }
  return formatCollection(payload as Record<string, unknown>);
}

const HANDLERS: Record<
  string,
  (
    arguments_: Record<string, unknown>,
    options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
  ) => Promise<string>
> = {
  holdings: holdingsTool,
  nft: nftTool,
  collection: collectionTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new AlchemyError(`unknown Alchemy tool ${name}`);
  }
  return handler(arguments_, options);
}
