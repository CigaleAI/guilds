import { Type, type Static, type TSchema } from "typebox";
import { JsonValueSchema } from "../../lib/json.js";

// The Alchemy responses the tools read: the NFT API's, and the Solana DAS JSON-RPC's. Each object
// keeps the fields Alchemy sends beyond the ones named.

/** Text Alchemy sends, sends as null, or leaves out. */
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** A figure Alchemy sends as a number or as numeric text, depending on the token; null when it has none. */
export const Figure = Type.Union([Type.Number(), Type.String(), Type.Null()]);
export type Figure = Static<typeof Figure>;

/** A figure field, which Alchemy may also leave out. */
const FigureField = Type.Optional(Figure);

/** Alchemy's spam flag: a boolean, or its text. */
const Spam = Type.Optional(Type.Union([Type.Boolean(), Type.String(), Type.Null()]));

/** A count, or a page number, DAS sends; null when it has none. */
const Count = Type.Optional(Type.Union([Type.Number(), Type.Null()]));

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** OpenSea's figures for a collection; Alchemy spells the key `openSeaMetadata` or `openseaMetadata`. */
const OpenSeaMetadata = Nullable(Type.Object({ floorPrice: FigureField }));

const Collection = Nullable(Type.Object({ name: Text }));

/** The answer to a ping, of which connecting reads only that it is one. */
export const PingResponse = Type.Object({});

/** A contract: the `contract` of an NFT, or the whole of a contract's metadata. */
export const ContractResponse = Type.Object({
  address: Text,
  contractAddress: Text,
  name: Text,
  symbol: Text,
  tokenType: Text,
  totalSupply: FigureField,
  isSpam: Spam,
  collection: Collection,
  openSeaMetadata: OpenSeaMetadata,
  openseaMetadata: OpenSeaMetadata,
});
export type ContractResponse = Static<typeof ContractResponse>;

export const NftResponse = Type.Object({
  contract: Nullable(ContractResponse),
  contractAddress: Text,
  tokenId: Text,
  tokenType: Text,
  name: Text,
  balance: FigureField,
  isSpam: Spam,
  collection: Collection,
  openSeaMetadata: OpenSeaMetadata,
  openseaMetadata: OpenSeaMetadata,
});
export type NftResponse = Static<typeof NftResponse>;

export const HoldingsResponse = Type.Object({
  ownedNfts: Type.Optional(Type.Array(NftResponse)),
  totalCount: FigureField,
  pageKey: Text,
});
export type HoldingsResponse = Static<typeof HoldingsResponse>;

/** A JSON-RPC error that is an object: its message. */
export const RpcError = Type.Object({ message: Text });

/** A JSON-RPC response: its `result`, which the method's own schema reads, or an `error` as an object with a message or as text. */
export const RpcEnvelope = Type.Object({
  result: Type.Optional(JsonValueSchema),
  error: Type.Optional(Type.Union([RpcError, Type.String(), Type.Null()])),
});

/** The grouping of a DAS asset: its collection, named by the `collection` key. */
const DasGroup = Type.Object({
  group_key: Text,
  group_value: Text,
  collection_metadata: Nullable(Type.Object({ name: Text })),
});
export type DasGroup = Static<typeof DasGroup>;

/** A DAS asset: an NFT on Solana, its collection named by a `collection` grouping. */
export const DasAsset = Type.Object({
  id: Text,
  interface: Text,
  content: Nullable(Type.Object({ metadata: Nullable(Type.Object({ name: Text, symbol: Text })) })),
  grouping: Nullable(Type.Array(DasGroup)),
});
export type DasAsset = Static<typeof DasAsset>;

export const DasPage = Type.Object({ items: Type.Optional(Type.Array(DasAsset)), total: Count, page: Count });
export type DasPage = Static<typeof DasPage>;

/** An error's detail one object deep: its message in `message` or `error`. */
export const ErrorDetail = Type.Object({ message: Text, error: Text });

/** Where an error body may carry its message: as text, or as an error detail. */
const ErrorField = Type.Optional(Type.Union([Type.String(), Type.Null(), ErrorDetail]));

/** An error body: the message sits in `error` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ error: ErrorField, message: ErrorField });
export type ErrorBody = Static<typeof ErrorBody>;
