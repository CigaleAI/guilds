import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The Alchemy responses the tools read: the NFT API's, and the Solana DAS JSON-RPC's. Each object
// keeps the fields Alchemy sends beyond the ones named; a field the tools print as it comes is
// `Shown`, since Alchemy sends a number, a string, or null for it depending on the token.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** OpenSea's figures for a collection; Alchemy spells the key `openSeaMetadata` or `openseaMetadata`. */
const OpenSeaMetadata = Nullable(Type.Object({ floorPrice: Shown }));

const Collection = Nullable(Type.Object({ name: Shown }));

/** A contract: the `contract` of an NFT, or the whole of a contract's metadata. */
export const ContractResponse = Type.Object({
  address: Shown,
  contractAddress: Shown,
  name: Shown,
  symbol: Shown,
  tokenType: Shown,
  totalSupply: Shown,
  isSpam: Shown,
  collection: Collection,
  openSeaMetadata: OpenSeaMetadata,
  openseaMetadata: OpenSeaMetadata,
});
export type ContractResponse = Static<typeof ContractResponse>;

export const NftResponse = Type.Object({
  contract: Nullable(ContractResponse),
  contractAddress: Shown,
  tokenId: Shown,
  tokenType: Shown,
  name: Shown,
  balance: Shown,
  isSpam: Shown,
  collection: Collection,
  openSeaMetadata: OpenSeaMetadata,
  openseaMetadata: OpenSeaMetadata,
});
export type NftResponse = Static<typeof NftResponse>;

export const HoldingsResponse = Type.Object({
  ownedNfts: Type.Optional(Type.Array(NftResponse)),
  totalCount: Shown,
  pageKey: Shown,
});
export type HoldingsResponse = Static<typeof HoldingsResponse>;

/** A JSON-RPC response: its `result`, or an `error` as an object with a message or as text. */
export const RpcEnvelope = Type.Object({ result: Shown, error: Shown });

export const RpcError = Type.Object({ message: Shown });

/** A DAS asset: an NFT on Solana, its collection named by a `collection` grouping. */
export const DasAsset = Type.Object({
  id: Shown,
  interface: Shown,
  content: Nullable(Type.Object({ metadata: Nullable(Type.Object({ name: Shown, symbol: Shown })) })),
  grouping: Nullable(
    Type.Array(
      Type.Object({
        group_key: Shown,
        group_value: Shown,
        collection_metadata: Nullable(Type.Object({ name: Shown })),
      }),
    ),
  ),
});
export type DasAsset = Static<typeof DasAsset>;

export const DasPage = Type.Object({ items: Type.Optional(Type.Array(DasAsset)), total: Shown, page: Shown });
export type DasPage = Static<typeof DasPage>;

/** An error body: the message sits in `error` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ error: Shown, message: Shown });

export const ErrorDetail = Type.Object({ message: Shown, error: Shown });
