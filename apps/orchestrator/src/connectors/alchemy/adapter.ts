import { Type } from "@sinclair/typebox";
import { AlchemyError, CHAIN_DEFAULT, ChainName, collection, holdings, nft, ping, type ToolOptions } from "./client.js";
import { given, listRows } from "../format.js";
import { adapterTool, Paged, toolsAdapter } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";

/** Runs `work` with the login's Alchemy key and the context's HTTP client, its Alchemy errors as connector errors. */
function withKey(creds: Credentials, ctx: ConnectorContext, work: (options: ToolOptions) => Promise<string>): Promise<string> {
  const apiKey = requiredCredential(creds, "token", "Alchemy API key is missing");
  return translated(AlchemyError, () => work({ apiKey, client: ctx.http }));
}

const chain = Type.Optional(ChainName);

const holdingsTool = adapterTool({
  name: "holdings",
  parameters: Type.Object({
    owner: Type.String({ description: "Wallet address. ENS works on ethereum." }),
    chain,
    contract: Type.Optional(Type.String({ description: "Optional collection contract or Solana collection mint." })),
    ...Paged,
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      holdings(
        {
          owner: input.owner,
          chain: input.chain ?? CHAIN_DEFAULT,
          contract: given(input.contract),
          pageKey: given(input.page_key),
          limit: listRows(input.limit),
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
    withKey(creds, ctx, (options) => nft(given(input.contract), given(input.token_id), input.chain ?? CHAIN_DEFAULT, options)),
});

const collectionTool = adapterTool({
  name: "collection",
  parameters: Type.Object({
    contract: Type.String({ description: "Collection contract address, or Solana collection mint." }),
    chain,
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) => collection(given(input.contract), input.chain ?? CHAIN_DEFAULT, options)),
});

export default toolsAdapter([holdingsTool, nftTool, collectionTool], {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(AlchemyError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
});
