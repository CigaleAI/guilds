import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decode } from "../../lib/decode.js";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, argStr, clipRows, fmtNum, joinParts, rowLimit } from "../format.js";
import type { ApiGet } from "../types.js";
import {
  ContractResponse,
  DasAsset,
  DasPage,
  ErrorBody,
  ErrorDetail,
  HoldingsResponse,
  NftResponse,
  RpcEnvelope,
  RpcError,
} from "./responses.js";

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

/** `value` trimmed, when it is non-empty text. */
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectionName(item: Pick<ContractResponse, "collection">): string {
  return nonEmpty(item.collection?.name) ?? "";
}

function isSpam(item: Pick<ContractResponse, "isSpam">): boolean {
  const flag = item.isSpam;
  return flag === true || flag === "true";
}

type Floored = Pick<ContractResponse, "openSeaMetadata" | "openseaMetadata">;

/** The first OpenSea floor price among `sources`, as `floor=…`. */
function floorPrice(sources: Floored[]): string {
  for (const source of sources) {
    for (const meta of [source.openSeaMetadata, source.openseaMetadata]) {
      const price = meta?.floorPrice;
      if (price !== null && price !== undefined && price !== "") {
        return `floor=${fmtNum(price)}`;
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

/** The token type, a balance other than one, and the spam mark of an NFT. */
function nftExtras(item: NftResponse, contract: ContractResponse): string[] {
  const extra: string[] = [];
  const tokenType = item.tokenType ?? contract.tokenType;
  if (tokenType) {
    extra.push(String(tokenType).trim());
  }
  const balance = item.balance;
  if (balance !== null && balance !== undefined && balance !== "" && balance !== "1" && balance !== 1) {
    extra.push(`bal=${fmtNum(balance)}`);
  }
  if (isSpam(item) || isSpam(contract)) {
    extra.push("spam");
  }
  return extra;
}

function nftRow(item: NftResponse): string {
  const contract = item.contract ?? {};
  const address = contract.address ?? item.contractAddress;
  const token = tokenLabel(item.tokenId, address);
  const collection = (typeof contract.name === "string" ? contract.name : "") || collectionName(item);
  const sameAsCollection = item.name && collection && String(item.name).trim() === collection.trim();
  const display = sameAsCollection ? "" : item.name;
  return joinParts(address, contract.symbol, collection, token, display, ...nftExtras(item, contract));
}

function contractRow(item: ContractResponse): string {
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

export function formatHoldings(payload: HoldingsResponse, owner: string, chain: string, limit = LIST_DEFAULT): string {
  const owned = payload.ownedNfts ?? [];
  const total = payload.totalCount;
  const head = joinParts(owner, chain, `total=${fmtNum(total !== null && total !== undefined ? total : owned.length)}`);
  const body = clipRows(owned.map((item) => nftRow(item)).filter(Boolean), limit);
  const parts = [head];
  if (body !== "no results") {
    parts.push(body);
  }
  const pageKey = nonEmpty(payload.pageKey);
  if (pageKey) {
    parts.push(`page=${pageKey}`);
  }
  return parts.join("\n");
}

export function formatNft(payload: NftResponse): string {
  if (Object.keys(payload).length === 0) {
    return "no results";
  }
  const parts = [nftRow(payload), floorPrice([payload, payload.contract ?? {}])].filter(Boolean);
  return parts.length ? parts.join("\n") : "no results";
}

export function formatCollection(payload: ContractResponse): string {
  if (Object.keys(payload).length === 0) {
    return "no results";
  }
  const parts = [contractRow(payload), floorPrice([payload])].filter(Boolean);
  return parts.length ? parts.join("\n") : "no results";
}

/** The id and name of the collection a DAS asset's `collection` grouping names. */
function dasCollection(item: DasAsset): { id: string; title: string } {
  const group = (item.grouping ?? []).find((row) => row.group_key === "collection");
  if (!group) {
    return { id: "", title: "" };
  }
  return { id: String(group.group_value ?? "").trim(), title: nonEmpty(group.collection_metadata?.name) ?? "" };
}

/** A DAS asset's contract: its collection, or the mint itself when it has none. */
function dasContract(item: DasAsset): ContractResponse {
  const metadata = item.content?.metadata ?? {};
  const collection = dasCollection(item);
  return {
    address: collection.id || item.id,
    name: collection.title || metadata.name,
    symbol: metadata.symbol,
    tokenType: item.interface,
  };
}

/** A DAS asset as the NFT API would describe it. */
function fromDas(item: DasAsset): NftResponse {
  return {
    contract: dasContract(item),
    tokenId: item.id,
    name: item.content?.metadata?.name,
    tokenType: item.interface,
  };
}

/** A DAS page as the NFT API's holdings: a next page when this one is full. */
function dasHoldings(payload: DasPage, limit: number): HoldingsResponse {
  const owned = (payload.items ?? []).map((item) => fromDas(item));
  const total = payload.total;
  const page = payload.page;
  const parsed = page !== null && page !== undefined && page !== "" ? Number.parseInt(String(page), 10) : 1;
  const pageN = Number.isFinite(parsed) ? parsed : 1;
  return {
    ownedNfts: owned,
    totalCount: total !== null && total !== undefined ? total : owned.length,
    pageKey: owned.length >= limit ? String(pageN + 1) : "",
  };
}

/** The message of an error body, as text or one object deeper. */
function errorMessage(payload: unknown): string | null {
  if (!Value.Check(ErrorBody, payload)) {
    return null;
  }
  const detail = payload.error ?? payload.message;
  const text = nonEmpty(detail);
  if (text) {
    return text;
  }
  return Value.Check(ErrorDetail, detail) ? nonEmpty(detail.message ?? detail.error) : null;
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
  return errorMessage(payload) ?? `Alchemy HTTP ${response.status}`;
}

type AlchemyOptions = { client?: FetchFn; proxyUrl?: string };

type ToolOptions = AlchemyOptions & { apiKey: string };

function unexpected(problem: string): AlchemyError {
  return new AlchemyError(`Alchemy returned an unexpected response at ${problem}`);
}

async function parsedBody(response: Response): Promise<unknown> {
  if (response.status >= 400) {
    throw new AlchemyError(await errorDetail(response), response.status);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new AlchemyError("Alchemy returned a non-JSON body");
  }
}

/** One NFT API GET: the request on the host of `network`. */
type NftGet<T extends TSchema> = ApiGet<T> & { network: string };

/** One DAS call on the Solana RPC: `method` with its `params`, the result decoded with `schema`. */
type DasCall<T extends TSchema> = { method: string; params: Record<string, unknown>; schema: T };

/** One page of the NFTs an owner holds, within one collection when `contract` is set; `pageKey` empty for the first. */
type HoldingsPage = { owner: string; contract: string; pageKey: string; limit: number };

/** The NFT API's response at `path` on `network`, as `schema` describes it. */
async function getJson<T extends TSchema>(
  request: NftGet<T>,
  apiKey: string,
  options: AlchemyOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new AlchemyError("Alchemy API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const url = withQuery(`${NFT_HOST.replace("{network}", request.network)}/${key}${request.path}`, request.params);
  const response = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
  return decode(request.schema, await parsedBody(response), unexpected);
}

/** The result of the DAS `method` called with `params`, as `schema` describes it. */
async function das<T extends TSchema>(
  request: DasCall<T>,
  apiKey: string,
  options: AlchemyOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new AlchemyError("Alchemy API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(`${SOLANA_RPC}/${key}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: request.method, params: request.params }),
  });
  const payload = decode(RpcEnvelope, await parsedBody(response), unexpected);
  const error = payload.error;
  if (error) {
    const message = Value.Check(RpcError, error) ? error.message || "Alchemy RPC error" : error;
    throw new AlchemyError(String(message));
  }
  return decode(request.schema, payload.result, unexpected);
}

/** The DAS params of a holdings page: by owner, or within one collection. */
function dasHoldingsParams(request: HoldingsPage): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ownerAddress: request.owner,
    limit: request.limit,
    options: { showFungible: false, showCollectionMetadata: true },
  };
  if (request.contract) {
    params.grouping = ["collection", request.contract];
  }
  const page = Number.parseInt(request.pageKey, 10);
  if (!request.pageKey) {
    params.page = 1;
  } else if (Number.isFinite(page)) {
    params.page = Math.max(1, page);
  } else {
    params.after = request.pageKey;
  }
  return params;
}

async function solanaHoldings(request: HoldingsPage, options: ToolOptions): Promise<HoldingsResponse> {
  const method = request.contract ? "searchAssets" : "getAssetsByOwner";
  const payload = await das({ method, params: dasHoldingsParams(request), schema: DasPage }, options.apiKey, options);
  return dasHoldings(payload, request.limit);
}

const PING = Type.Unknown();

export async function ping(apiKey: string, options: AlchemyOptions = {}): Promise<void> {
  const params = { owner: PING_OWNER, pageSize: "1", withMetadata: "false" };
  await getJson({ network: "eth-mainnet", path: "/getNFTsForOwner", params, schema: PING }, apiKey, options);
}

export async function holdingsTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const owner = argStr(arguments_, "owner");
  if (!owner) {
    throw new AlchemyError("owner is required");
  }
  const [chain, network] = resolveChain(arguments_);
  const limit = rowLimit(arguments_);
  const contract = argStr(arguments_, "contract");
  const pageKey = argStr(arguments_, "page_key");
  if (chain === "solana") {
    const payload = await solanaHoldings({ owner, contract, pageKey, limit }, options);
    return formatHoldings(payload, owner, chain, limit);
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
  const payload = await getJson(
    { network, path: "/getNFTsForOwner", params, schema: HoldingsResponse },
    options.apiKey,
    options,
  );
  return formatHoldings(payload, owner, chain, limit);
}

export async function nftTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const contract = argStr(arguments_, "contract");
  const tokenId = argStr(arguments_, "token_id");
  const [chain, network] = resolveChain(arguments_);
  if (chain === "solana") {
    const mint = contract || tokenId;
    if (!mint) {
      throw new AlchemyError("contract is required");
    }
    const payload = await das({ method: "getAsset", params: { id: mint }, schema: DasAsset }, options.apiKey, options);
    return formatNft(fromDas(payload));
  }
  if (!contract) {
    throw new AlchemyError("contract is required");
  }
  if (!tokenId) {
    throw new AlchemyError("token_id is required");
  }
  const payload = await getJson(
    { network, path: "/getNFTMetadata", params: { contractAddress: contract, tokenId }, schema: NftResponse },
    options.apiKey,
    options,
  );
  return formatNft(payload);
}

export async function collectionTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const contract = argStr(arguments_, "contract");
  if (!contract) {
    throw new AlchemyError("contract is required");
  }
  const [chain, network] = resolveChain(arguments_);
  if (chain === "solana") {
    const payload = await das({ method: "getAsset", params: { id: contract }, schema: DasAsset }, options.apiKey, options);
    return formatCollection(dasContract(payload));
  }
  const payload = await getJson(
    { network, path: "/getContractMetadata", params: { contractAddress: contract }, schema: ContractResponse },
    options.apiKey,
    options,
  );
  return formatCollection(payload);
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: ToolOptions) => Promise<string>> = {
  holdings: holdingsTool,
  nft: nftTool,
  collection: collectionTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: ToolOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new AlchemyError(`unknown Alchemy tool ${name}`);
  }
  return handler(arguments_, options);
}
