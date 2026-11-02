import { Type } from "typebox";
import { CredentialError, SECRET_DESCRIPTION_MAX, validateSecretDescription, validateSecretName } from "../credentials/validate.js";
import { nativeTool } from "./types.js";
import { ToolArgumentError, ToolUnavailableError } from "./errors.js";

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
      throw new ToolArgumentError(error.message, { cause: error });
    }
    throw error;
  }
}

/** A secret's name: the environment variable it is set as. */
const SecretName = Type.String({ description: "environment variable name, for example ACME_API_KEY" });

export const secretStore = nativeTool({
  name: "secret_store",
  description: STORE_DESCRIPTION,
  parameters: Type.Object({
    name: SecretName,
    description: Type.String({ description: `how agents use this value, at most ${SECRET_DESCRIPTION_MAX} characters` }),
    file: Type.String({ description: "path in your home to a file holding the value" }),
  }),
  async handler(_services, run, hooks, { arguments: args }) {
    const store = hooks.secret_store;
    if (store === null) {
      throw new ToolUnavailableError("secret storage is not available");
    }
    const stored = await store.store({ name: args.name, description: args.description, file: args.file });
    run.secrets[stored.name] = stored.value;
    return (
      `${JSON.stringify({ stored: stored.name, rotated: stored.rotated })}\n` +
      `${stored.name} is in your environment from the next generation.`
    );
  },
});

export const secretRequest = nativeTool({
  name: "secret_request",
  description: REQUEST_DESCRIPTION,
  parameters: Type.Object({
    name: SecretName,
    description: Type.String({ description: `how you will use the value, at most ${SECRET_DESCRIPTION_MAX} characters` }),
    reason: Type.String({ description: `why you need it now, at most ${SECRET_REASON_MAX} characters` }),
  }),
  async handler(_services, run, _hooks, { arguments: args }) {
    if (run.run_kind !== "direct") {
      throw new ToolUnavailableError("secret_request is only available in a direct chat; say what you need with group_post");
    }
    const name = checked(() => validateSecretName(args.name));
    checked(() => validateSecretDescription(args.description));
    const reason = args.reason.trim();
    if (!reason) {
      throw new ToolArgumentError("reason must contain non-whitespace text");
    }
    if (reason.length > SECRET_REASON_MAX) {
      throw new ToolArgumentError(`reason must be at most ${SECRET_REASON_MAX} characters`);
    }
    if (run.secret_names.includes(name)) {
      return JSON.stringify({ status: "available" });
    }
    return (
      `${JSON.stringify({ widget: "secret_request", name, status: "asked" })}\n` +
      `The operator has been asked in this chat. End your turn now; ${name} is in your environment once they answer.`
    );
  },
});
