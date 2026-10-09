import { callTool, ping, QontoError, type QontoCreds } from "./client.js";
import { ConnectorError, translated, type Adapter, type Credentials } from "../types.js";

function qontoCreds(creds: Credentials, message: string): QontoCreds {
  const login = creds.login ?? "";
  const secretKey = creds.secret_key ?? "";
  if (!login || !secretKey) {
    throw new ConnectorError(message, 401);
  }
  return { login, secretKey };
}

const adapter: Adapter = {
  async validate(creds, ctx) {
    const qonto = qontoCreds(creds, "qonto login and secret key are required");
    return translated(QontoError, () => ping(qonto, { client: ctx.http }));
  },
  async call(name, args, creds, ctx) {
    const qonto = qontoCreds(creds, "Qonto credentials are missing");
    return translated(QontoError, () =>
      callTool(name, args, {
        ...qonto,
        client: ctx.http,
        ...(ctx.workspace_dir ? { workspaceDir: ctx.workspace_dir } : {}),
      }),
    );
  },
};

export default adapter;
