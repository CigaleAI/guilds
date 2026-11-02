import { Type } from "@sinclair/typebox";
import {
  AlchemyError,
  CHAIN_LIST,
  CHAIN_NAMES,
  collection,
  holdings,
  nft,
  ping,
  resolveChain,
  type ToolOptions,
} from "./client.js";
import { LIST_CAP, LIST_DEFAULT } from "../format.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";

/** Runs `work` with the login's Alchemy key and the context's HTTP client, its Alchemy errors as connector errors. */
function withKey(creds: Credentials, ctx: ConnectorContext, work: (options: ToolOptions) => Promise<string>): Promise<string> {
  const apiKey = requiredCredential(creds, "token", "Alchemy API key is missing");
  return translated(AlchemyError, () => work({ apiKey, client: ctx.http }));
}

/** The rows a call asks for: `limit` within 1 and the cap, the default when it names none. */
function rowCount(limit: number | undefined): number {
  return Math.max(1, Math.min(LIST_CAP, limit ?? LIST_DEFAULT));
}

/** Text a call sends, trimmed; empty when it is blank or absent. */
function given(value: string | undefined): string {
  return value?.trim() ?? "";
}

const chain = Type.Optional(Type.String({ enum: CHAIN_NAMES, description: `${CHAIN_LIST}. Default ethereum.` }));

const holdingsTool = adapterTool({
  name: "holdings",
  parameters: Type.Object({
    owner: Type.String({ description: "Wallet address. ENS works on ethereum." }),
    chain,
    contract: Type.Optional(Type.String({ description: "Optional collection contract or Solana collection mint." })),
    page_key: Type.Optional(Type.String({ description: "Continue from a previous page_key." })),
    limit: Type.Optional(Type.Integer({ description: "Rows this page. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      holdings(
        {
          owner: input.owner,
          chain: resolveChain(input.chain),
          contract: given(input.contract),
          pageKey: given(input.page_key),
          limit: rowCount(input.limit),
        },
        options,
      ),
    ),
});

const nftTool = adapterTool({
  name: "nft",
  parameters: Type.Object({
    contract: Type.String({ description: "NFT contract address, or Solana mint." }),
    token_id: Type.Optional(Type.String({ description: "Token id. Required on EVM chains." })),
    chain,
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) => nft(given(input.contract), given(input.token_id), resolveChain(input.chain), options)),
});

const collectionTool = adapterTool({
  name: "collection",
  parameters: Type.Object({
    contract: Type.String({ description: "Collection contract address, or Solana collection mint." }),
    chain,
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) => collection(given(input.contract), resolveChain(input.chain), options)),
});

export default toolsAdapter([holdingsTool, nftTool, collectionTool], {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(AlchemyError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
});
