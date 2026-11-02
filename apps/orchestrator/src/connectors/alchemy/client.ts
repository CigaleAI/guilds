import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertMatches } from "../../lib/decode.js";
import type { JsonObject } from "../../lib/json.js";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, clipRows, fmtNum, joinParts } from "../format.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
import type { ApiGet } from "../types.js";
import {
  ContractResponse,
  DasAsset,
  DasPage,
  ErrorBody,
  ErrorDetail,
  HoldingsResponse,
  NftResponse,
  PingResponse,
  RpcEnvelope,
  RpcError,
  type DasGroup,
} from "./responses.js";

export const NFT_HOST = "https://{network}.g.alchemy.com/nft/v3";
export const SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2";
export const CHAIN_DEFAULT = "ethereum";
export const PING_OWNER = "0x0000000000000000000000000000000000000000";

/** The Alchemy network of each chain the tools take. */
export const CHAINS = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  bsc: "bnb-mainnet",
  optimism: "opt-mainnet",
  ink: "ink-mainnet",
  robinhood: "robinhood-mainnet",
  solana: "solana-mainnet",
} satisfies Record<string, string>;

/** A chain the tools take. */
export type Chain = keyof typeof CHAINS;

export const CHAIN_NAMES = Object.keys(CHAINS);
export const CHAIN_LIST = CHAIN_NAMES.join(", ");

export class AlchemyError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AlchemyError";
    this.status = status;
  }
}

/** Whether `name` is a chain the tools take. */
function isChain(name: string): name is Chain {
  return Object.hasOwn(CHAINS, name);
}

/** The chain a call names, in any case; the default when it names none. Throws on a chain the tools do not take. */
export function resolveChain(name: string | undefined): Chain {
  const chain = name?.trim().toLowerCase() || CHAIN_DEFAULT;
  if (!isChain(chain)) {
    throw new AlchemyError(`chain must be ${CHAIN_LIST}`);
  }
  return chain;
}

/** One page of the NFTs an owner holds on a chain, within one collection when `contract` is set; `pageKey` empty for the first. */
export type HoldingsRequest = { owner: string; chain: Chain; contract: string; pageKey: string; limit: number };

/** Text, trimmed; null when it is blank or absent. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function collectionName(item: Pick<ContractResponse, "collection">): string {
  return text(item.collection?.name) ?? "";
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

/** An NFT's token id as a row shows it: `#n` when numeric, nothing when it is the contract's own address. */
function tokenLabel(tokenId: string | null | undefined, address: string | null | undefined): string {
  const label = tokenId?.trim();
  if (!label) {
    return "";
  }
  if (/^\d+$/.test(label)) {
    return `#${label}`;
  }
  if (label.toLowerCase() === (address ?? "").trim().toLowerCase()) {
    return "";
  }
  return label;
}

/** The token type, a balance other than one, and the spam mark of an NFT. */
function nftExtras(item: NftResponse, contract: ContractResponse): string[] {
  const extra: string[] = [];
  const tokenType = item.tokenType ?? contract.tokenType;
  if (tokenType) {
    extra.push(tokenType.trim());
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
  const collection = contract.name || collectionName(item);
  const sameAsCollection = item.name && collection && item.name.trim() === collection.trim();
  const display = sameAsCollection ? "" : item.name;
  return joinParts(address, contract.symbol, collection, token, display, ...nftExtras(item, contract));
}

function contractRow(item: ContractResponse): string {
  const extra: string[] = [];
  if (item.tokenType) {
    extra.push(item.tokenType.trim());
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
  const head = joinParts(owner, chain, `total=${fmtNum(payload.totalCount ?? owned.length)}`);
  const body = clipRows(owned.map((item) => nftRow(item)).filter(Boolean), limit);
  const parts = [head];
  if (body !== "no results") {
    parts.push(body);
  }
  const pageKey = text(payload.pageKey);
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

/** The grouping that names a DAS asset's collection; undefined when it has none. */
function dasCollection(item: DasAsset): DasGroup | undefined {
  return (item.grouping ?? []).find((row) => row.group_key === "collection");
}

/** The address of a DAS asset's contract: its collection's mint, or its own when it has no collection. */
function dasAddress(item: DasAsset): string | null {
  return text(dasCollection(item)?.group_value) ?? item.id ?? null;
}

/** The name of a DAS asset's contract: its collection's, or its own when the collection has none. */
function dasName(item: DasAsset): string | null {
  return text(dasCollection(item)?.collection_metadata?.name) ?? item.content?.metadata?.name ?? null;
}

/** A DAS asset's contract: its collection, or the mint itself when it has none. */
function dasContract(item: DasAsset): ContractResponse {
  return {
    address: dasAddress(item),
    name: dasName(item),
    symbol: item.content?.metadata?.symbol ?? null,
    tokenType: item.interface ?? null,
  };
}

/** A DAS asset as the NFT API would describe it. */
function fromDas(item: DasAsset): NftResponse {
  return {
    contract: dasContract(item),
    tokenId: item.id ?? null,
    name: item.content?.metadata?.name ?? null,
    tokenType: item.interface ?? null,
  };
}

/** A DAS page as the NFT API's holdings: a next page when this one is full. */
function dasHoldings(payload: DasPage, limit: number): HoldingsResponse {
  const owned = (payload.items ?? []).map((item) => fromDas(item));
  const page = payload.page ?? 1;
  return {
    ownedNfts: owned,
    totalCount: payload.total ?? owned.length,
    pageKey: owned.length >= limit ? String(page + 1) : "",
  };
}

/** The message of an error body, as text or one object deeper. */
function errorMessage(body: ErrorBody): string | null {
  const detail = body.error ?? body.message;
  return Value.Check(ErrorDetail, detail) ? text(detail.message ?? detail.error) : text(detail);
}

/** Alchemy's APIs as the client reads their responses. */
const ALCHEMY: ConnectorApi<typeof ErrorBody> = {
  name: "Alchemy",
  error: (message, status) => new AlchemyError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

type AlchemyOptions = { client?: FetchFn; proxyUrl?: string };

/** The options of a call with a login's key. */
export type ToolOptions = AlchemyOptions & { apiKey: string };

/** One NFT API GET: the request on the host of `network`. */
type NftGet<T extends TSchema> = ApiGet<T> & { network: string };

/** One DAS call on the Solana RPC: `method` with its `params`, the result decoded with `schema`. */
type DasCall<T extends TSchema> = { method: string; params: JsonObject; schema: T };

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
  return decodeResponse(ALCHEMY, response, request.schema);
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
  const { result, error } = await decodeResponse(ALCHEMY, response, RpcEnvelope);
  if (error) {
    throw new AlchemyError(Value.Check(RpcError, error) ? (text(error.message) ?? "Alchemy RPC error") : error);
  }
  assertMatches(request.schema, result, (problem) => new AlchemyError(`Alchemy returned an unexpected result at ${problem}`));
  return result;
}

/** The DAS params of a holdings page: by owner, or within one collection; a numeric page key as the page, another as the cursor. */
function dasHoldingsParams(request: HoldingsRequest): JsonObject {
  const { owner, contract, pageKey, limit } = request;
  const page = Number.parseInt(pageKey, 10);
  return {
    ownerAddress: owner,
    limit,
    options: { showFungible: false, showCollectionMetadata: true },
    ...(contract ? { grouping: ["collection", contract] } : {}),
    ...(!pageKey ? { page: 1 } : Number.isFinite(page) ? { page: Math.max(1, page) } : { after: pageKey }),
  };
}

async function solanaHoldings(request: HoldingsRequest, options: ToolOptions): Promise<HoldingsResponse> {
  const method = request.contract ? "searchAssets" : "getAssetsByOwner";
  const payload = await das({ method, params: dasHoldingsParams(request), schema: DasPage }, options.apiKey, options);
  return dasHoldings(payload, request.limit);
}

export async function ping(apiKey: string, options: AlchemyOptions = {}): Promise<void> {
  const params = { owner: PING_OWNER, pageSize: "1", withMetadata: "false" };
  await getJson({ network: CHAINS.ethereum, path: "/getNFTsForOwner", params, schema: PingResponse }, apiKey, options);
}

/** The page of an owner's NFTs `request` asks for: DAS on Solana, the NFT API elsewhere. */
export async function holdings(request: HoldingsRequest, options: ToolOptions): Promise<string> {
  const { chain, contract, pageKey, limit } = request;
  const owner = request.owner.trim();
  if (!owner) {
    throw new AlchemyError("owner is required");
  }
  if (chain === "solana") {
    const payload = await solanaHoldings({ ...request, owner }, options);
    return formatHoldings(payload, owner, chain, limit);
  }
  const params = {
    owner,
    withMetadata: "true",
    pageSize: String(limit),
    ...(contract ? { "contractAddresses[]": contract } : {}),
    ...(pageKey ? { pageKey } : {}),
  };
  const payload = await getJson(
    { network: CHAINS[chain], path: "/getNFTsForOwner", params, schema: HoldingsResponse },
    options.apiKey,
    options,
  );
  return formatHoldings(payload, owner, chain, limit);
}

/** One NFT on `chain`: by contract and token id, or on Solana by its mint. */
export async function nft(contract: string, tokenId: string, chain: Chain, options: ToolOptions): Promise<string> {
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
    { network: CHAINS[chain], path: "/getNFTMetadata", params: { contractAddress: contract, tokenId }, schema: NftResponse },
    options.apiKey,
    options,
  );
  return formatNft(payload);
}

/** A collection on `chain`, by its contract, or on Solana by its collection mint. */
export async function collection(contract: string, chain: Chain, options: ToolOptions): Promise<string> {
  if (!contract) {
    throw new AlchemyError("contract is required");
  }
  if (chain === "solana") {
    const payload = await das({ method: "getAsset", params: { id: contract }, schema: DasAsset }, options.apiKey, options);
    return formatCollection(dasContract(payload));
  }
  const payload = await getJson(
    { network: CHAINS[chain], path: "/getContractMetadata", params: { contractAddress: contract }, schema: ContractResponse },
    options.apiKey,
    options,
  );
  return formatCollection(payload);
}
