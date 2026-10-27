import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The Qonto responses the tools read. Each object keeps the fields Qonto sends beyond the ones
// named; a field the tools print as it comes is `Shown`.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

const BankAccount = Type.Object({ id: Shown, name: Shown, iban: Shown, currency: Shown, status: Shown });

export const OrganizationResponse = Type.Object({
  organization: Nullable(Type.Object({ name: Shown, bank_accounts: Nullable(Type.Array(BankAccount)) })),
});
export type OrganizationResponse = Static<typeof OrganizationResponse>;

export const Transaction = Type.Object({
  id: Shown,
  settled_at: Shown,
  amount: Shown,
  currency: Shown,
  side: Shown,
  label: Shown,
  operation_type: Shown,
  category: Shown,
  card_last_digits: Shown,
  note: Shown,
  reference: Shown,
  bank_account_id: Shown,
  attachment_ids: Nullable(Type.Array(Type.Unknown())),
  attachment_required: Shown,
  attachment_lost: Shown,
});
export type Transaction = Static<typeof Transaction>;

export const TransactionsResponse = Type.Object({
  transactions: Nullable(Type.Array(Transaction)),
  meta: Nullable(Type.Object({ next_page: Nullable(Type.Union([Type.String(), Type.Number()])) })),
});
export type TransactionsResponse = Static<typeof TransactionsResponse>;

export const TransactionResponse = Type.Object({ transaction: Transaction });

/** An upload's response: the tools read the attachment back from the transaction instead. */
export const UploadResponse = Type.Unknown();

/** An error body: the message is the first error's `detail` or `message`. */
export const ErrorBody = Type.Object({
  errors: Type.Array(Type.Object({ detail: Shown, message: Shown })),
});
