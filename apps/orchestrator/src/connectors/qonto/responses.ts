import { Type, type Static, type TSchema } from "typebox";
import { JsonValueSchema } from "../../lib/json.js";

// The Qonto responses the tools read, each field as Qonto sends it: a field with no value may
// come as null or be left out. Each object keeps the fields Qonto sends beyond the ones named.

/** Text Qonto sends, sends as null, or leaves out. */
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** A flag Qonto sends, sends as null, or leaves out. */
const Flag = Type.Optional(Type.Union([Type.Boolean(), Type.Null()]));

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

const BankAccount = Type.Object({ id: Text, name: Text, iban: Text, currency: Text, status: Text });

export const OrganizationResponse = Type.Object({
  organization: Nullable(Type.Object({ name: Text, bank_accounts: Nullable(Type.Array(BankAccount)) })),
});
export type OrganizationResponse = Static<typeof OrganizationResponse>;

/** A transaction: its amount in the account's currency, what it was, and the invoices attached to it. */
export const Transaction = Type.Object({
  id: Text,
  settled_at: Text,
  amount: Type.Optional(Type.Number()),
  currency: Text,
  side: Text,
  label: Text,
  operation_type: Text,
  category: Text,
  card_last_digits: Text,
  note: Text,
  reference: Text,
  bank_account_id: Text,
  attachment_ids: Nullable(Type.Array(Type.String())),
  attachment_required: Flag,
  attachment_lost: Flag,
});
export type Transaction = Static<typeof Transaction>;

export const TransactionsResponse = Type.Object({
  transactions: Nullable(Type.Array(Transaction)),
  meta: Nullable(Type.Object({ next_page: Nullable(Type.Union([Type.String(), Type.Number()])) })),
});
export type TransactionsResponse = Static<typeof TransactionsResponse>;

export const TransactionResponse = Type.Object({ transaction: Transaction });

/** An upload's response, which the tools do not read: they read the attachment back from the transaction. */
export const UploadResponse = JsonValueSchema;

/** An error body: the message is the first error's `detail` or `message`. */
export const ErrorBody = Type.Object({
  errors: Type.Array(Type.Object({ detail: Text, message: Text })),
});
export type ErrorBody = Static<typeof ErrorBody>;
