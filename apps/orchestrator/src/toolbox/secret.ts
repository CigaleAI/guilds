import { CredentialError, SECRET_DESCRIPTION_MAX, validateSecretDescription, validateSecretName } from "../credentials/validate.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

export const SECRET_REASON_MAX = 400;

const STORE_DESCRIPTION =
  "Save a value you produced in the sandbox (a generated key, a token you obtained) as a secret: " +
  "an environment variable of this organisation, granted to you. Have a script write the value to " +
  "a file in your home and never print it; pass that file. The tool reads the file, stores the " +
  "value encrypted, and deletes the file. name is the variable name; names are shared by the whole " +
  "organisation, so pick one specific to its purpose. description tells agents how to use it " +
  `(at most ${SECRET_DESCRIPTION_MAX} characters). Storing again under a name you stored rotates its value. ` +
  "The variable is in your environment from the next generation. A value you already saw stays in " +
  "earlier results; results from this call onward are redacted. You cannot read a value back, " +
  "delete a secret, or share it; an operator does that.";

const REQUEST_DESCRIPTION =
  "Ask the operator in this chat for a secret you need and cannot produce yourself: an API key, " +
  "token, or password. The operator answers from a card in the conversation; the value never passes " +
  "through the chat. name is the environment variable name; description is how you will use it and " +
  "becomes the secret's description; reason is why you need it now " +
  `(at most ${SECRET_REASON_MAX} characters). When the result says asked, end your turn: the variable is ` +
  "in your environment once the operator answers. When it says available, the variable is already set.";

function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CredentialError) {
      throw new Error(error.message, { cause: error });
    }
    throw error;
  }
}

export const secretStore: Tool = {
  name: "secret_store",
  description: STORE_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "secret_store",
    STORE_DESCRIPTION,
    {
      name: { type: "string", description: "environment variable name, for example ACME_API_KEY" },
      description: {
        type: "string",
        description: `how agents use this value, at most ${SECRET_DESCRIPTION_MAX} characters`,
      },
      file: { type: "string", description: "path in your home to a file holding the value" },
    },
    ["name", "description", "file"],
  ),
  async handler(ctx: ToolContext, { arguments: args }) {
    const store = ctx.secret_store;
    if (store === null) {
      throw new Error("secret storage is not available");
    }
    const stored = await store.store({
      name: args.name,
      description: args.description,
      file: argString(args, "file"),
    });
    ctx.secrets[stored.name] = stored.value;
    return (
      `${JSON.stringify({ stored: stored.name, rotated: stored.rotated })}\n` +
      `${stored.name} is in your environment from the next generation.`
    );
  },
};

export const secretRequest: Tool = {
  name: "secret_request",
  description: REQUEST_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "secret_request",
    REQUEST_DESCRIPTION,
    {
      name: { type: "string", description: "environment variable name, for example ACME_API_KEY" },
      description: {
        type: "string",
        description: `how you will use the value, at most ${SECRET_DESCRIPTION_MAX} characters`,
      },
      reason: {
        type: "string",
        description: `why you need it now, at most ${SECRET_REASON_MAX} characters`,
      },
    },
    ["name", "description", "reason"],
  ),
  async handler(ctx: ToolContext, { arguments: args }) {
    if (ctx.run_kind !== "direct") {
      throw new Error("secret_request is only available in a direct chat; say what you need with group_post");
    }
    const name = checked(() => validateSecretName(args.name));
    checked(() => validateSecretDescription(args.description));
    const reason = argString(args, "reason").trim();
    if (!reason) {
      throw new Error("reason must contain non-whitespace text");
    }
    if (reason.length > SECRET_REASON_MAX) {
      throw new Error(`reason must be at most ${SECRET_REASON_MAX} characters`);
    }
    if (ctx.secret_names.includes(name)) {
      return JSON.stringify({ status: "available" });
    }
    return (
      `${JSON.stringify({ widget: "secret_request", name, status: "asked" })}\n` +
      `The operator has been asked in this chat. End your turn now; ${name} is in your environment once they answer.`
    );
  },
};
