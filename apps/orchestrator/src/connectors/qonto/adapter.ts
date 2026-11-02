import type { Static, TObject } from "@sinclair/typebox";
import {
  listBankAccounts,
  listMissingInvoices,
  ping,
  QontoError,
  transactionDetail,
  uploadInvoice,
  type QontoCreds,
  type QontoOptions,
} from "./client.js";
import { InvoiceUpload, MissingInvoicesQuery, NoParameters, TransactionLookup } from "./parameters.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { ConnectorError, translated, type AdapterTool, type ConnectorContext, type Credentials } from "../types.js";

function qontoCreds(creds: Credentials, message: string): QontoCreds {
  const login = creds.login ?? "";
  const secretKey = creds.secret_key ?? "";
  if (!login || !secretKey) {
    throw new ConnectorError(message, 401);
  }
  return { login, secretKey };
}

/** What a Qonto call is made with: the login's credentials, the run's HTTP client and workspace. */
function qontoOptions(creds: Credentials, ctx: ConnectorContext): QontoOptions {
  return {
    ...qontoCreds(creds, "Qonto credentials are missing"),
    client: ctx.http,
    ...(ctx.workspace_dir ? { workspaceDir: ctx.workspace_dir } : {}),
  };
}

/** The Qonto tool `name`: `work` on its decoded arguments, a `QontoError` answered as a `ConnectorError`. */
function qontoTool<P extends TObject>(
  name: string,
  parameters: P,
  work: (input: Static<P>, options: QontoOptions) => Promise<string>,
): AdapterTool {
  return adapterTool({
    name,
    parameters,
    run: (input, creds, ctx) => {
      const options = qontoOptions(creds, ctx);
      return translated(QontoError, () => work(input, options));
    },
  });
}

const TOOLS = [
  qontoTool("list_bank_accounts", NoParameters, (_input, options) => listBankAccounts(options)),
  qontoTool("list_missing_invoices", MissingInvoicesQuery, listMissingInvoices),
  qontoTool("get_transaction", TransactionLookup, (input, options) => transactionDetail(input.transaction_id, options)),
  qontoTool("upload_invoice", InvoiceUpload, uploadInvoice),
];

export default toolsAdapter(TOOLS, {
  async validate(creds, ctx) {
    const qonto = qontoCreds(creds, "qonto login and secret key are required");
    return translated(QontoError, () => ping(qonto, { client: ctx.http }));
  },
});
