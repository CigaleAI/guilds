import { Type, type Static } from "typebox";

// The parameters of the Qonto tools: each one's single declaration, which the loaded manifest
// offers as the tool's input_schema.

/** The side of the transactions `list_missing_invoices` scans: debits, credits, or both. */
const Side = Type.Union([Type.Literal("debit"), Type.Literal("credit"), Type.Literal("both")], {
  description: "Transaction side. Default debit.",
});

/** `list_bank_accounts`: no parameters. */
export const NoParameters = Type.Object({}, { additionalProperties: false });

/** `list_missing_invoices`: the accounts, settled dates, side and amount floor a scan covers, and the rows it shows. */
export const MissingInvoicesQuery = Type.Object(
  {
    bank_account_id: Type.Optional(
      Type.String({ description: "Scan this account only. Omit to scan every active account." }),
    ),
    settled_from: Type.Optional(
      Type.String({ description: "Inclusive start date (YYYY-MM-DD). Default: 90 days ago." }),
    ),
    settled_to: Type.Optional(Type.String({ description: "Inclusive end date (YYYY-MM-DD). Default: today (UTC)." })),
    side: Type.Optional(Side),
    min_amount: Type.Optional(Type.Number({ description: "Exclude transactions below this amount in euros." })),
    limit: Type.Optional(Type.Integer({ description: "Rows to show. Default 50, max 100." })),
  },
  { additionalProperties: false },
);
export type MissingInvoicesQuery = Static<typeof MissingInvoicesQuery>;

const TransactionId = Type.String({ description: "UUID of the transaction." });

/** `get_transaction`: one transaction by its id. */
export const TransactionLookup = Type.Object({ transaction_id: TransactionId }, { additionalProperties: false });

/** `upload_invoice`: the invoice file to attach to a transaction, and whether to attach it beside existing ones. */
export const InvoiceUpload = Type.Object(
  {
    transaction_id: TransactionId,
    file_path: Type.String({ description: "Path in the agent's home to a PDF, JPEG, or PNG." }),
    force: Type.Optional(
      Type.Boolean({ description: "Upload even if the transaction already has attachments. Default false." }),
    ),
  },
  { additionalProperties: false },
);
export type InvoiceUpload = Static<typeof InvoiceUpload>;
