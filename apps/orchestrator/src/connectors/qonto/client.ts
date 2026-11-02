import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "@sinclair/typebox";
import { AgentFileError, readAgentFile } from "../../lib/agent-file.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { clipRows, fmtNum, joinParts } from "../format.js";
import { decodeBody, failureMessage, type ConnectorApi } from "../response.js";
import { isSide, type InvoiceUpload, type MissingInvoicesQuery } from "./parameters.js";
import {
  ErrorBody,
  OrganizationResponse,
  TransactionResponse,
  TransactionsResponse,
  UploadResponse,
  type Transaction,
} from "./responses.js";

export const API_BASE = "https://thirdparty.qonto.com";
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MISSING_DISPLAY_CAP = 50;
export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 60_000;
const MAX_TRIES = 3;
/** The media type of each invoice file Qonto accepts, by its lowercased extension. */
const MIME = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

export class QontoError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "QontoError";
    this.status = status;
  }
}

export type QontoCreds = { login: string; secretKey: string };

export type QontoOptions = {
  login: string;
  secretKey: string;
  client?: FetchFn;
  proxyUrl?: string;
  workspaceDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const idempotencyKeys = new Map<string, string>();

export function isMissingInvoice(row: Transaction): boolean {
  if (row.attachment_ids?.length) {
    return false;
  }
  if (row.attachment_required !== true) {
    return false;
  }
  return row.attachment_lost !== true;
}

/** A transaction's amount; 0 when Qonto leaves it out. */
function amountOf(row: Transaction): number {
  return row.amount ?? 0;
}

function isoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new QontoError(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The settled dates a scan covers, both inclusive, as ISO dates. */
type SettledRange = { from: string; to: string };

function settledRange(scan: MissingInvoicesQuery, now: Date): SettledRange {
  const today = utcDay(now);
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 90);
  const fromArg = scan.settled_from?.trim();
  const toArg = scan.settled_to?.trim();
  return {
    from: fromArg ? isoDate(fromArg, "settled_from") : defaultFrom.toISOString().slice(0, 10),
    to: toArg ? isoDate(toArg, "settled_to") : today.toISOString().slice(0, 10),
  };
}

/** A Qonto query: each value sent as text, an undefined one left out. */
type QontoQuery = Record<string, string | boolean | number | undefined>;

function qontoUrl(pathName: string, params: QontoQuery = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `${API_BASE}${pathName}?${encoded}` : `${API_BASE}${pathName}`;
}

function authHeaders(creds: QontoCreds) {
  const login = creds.login.trim();
  const secretKey = creds.secretKey.trim();
  if (!login || !secretKey) {
    throw new QontoError("Qonto login and secret key are required", 401);
  }
  return { Authorization: `${login}:${secretKey}`, Accept: "application/json" };
}

/** The message of an error body: its first error's `detail`, else its `message`, trimmed; null when blank or absent. */
function errorMessage(body: ErrorBody): string | null {
  const first = body.errors[0];
  return (first?.detail ?? first?.message)?.trim() || null;
}

/** Qonto's API as the client reads its responses. */
const QONTO: ConnectorApi<typeof ErrorBody> = {
  name: "Qonto",
  error: (message, status) => new QontoError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

/** What a failed call to `requestPath` is reported as, its status and `detail` the failure's message. */
function messageForStatus(status: number, detail: string, requestPath: string): string {
  if (status === 401) {
    return "bad credentials";
  }
  if (status === 404 && requestPath.startsWith("/v2/transactions/")) {
    return "unknown transaction";
  }
  if (status === 422) {
    return `invalid file: ${detail}`;
  }
  return detail;
}

async function sleepMs(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (sleep) {
    await sleep(ms);
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The response of `send`, sent again on a 429 or a server error up to `MAX_TRIES` times, after the
 * wait the response's `Retry-After` names, else a doubling backoff.
 */
async function sendWithRetry(
  send: () => Promise<Response>,
  sleep?: (ms: number) => Promise<void>,
): Promise<Response> {
  let wait = 1_000;
  for (let attempt = 1; ; attempt += 1) {
    const response = await send();
    if ((response.status !== 429 && response.status < 500) || attempt === MAX_TRIES) {
      return response;
    }
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    await sleepMs(Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : wait, sleep);
    wait *= 2;
  }
}

/** One Qonto API call: `method` on `path` with its query, body and headers beside the login's, the JSON body decoded with `schema`. */
type QontoRequest<T extends TSchema> = {
  method: string;
  path: string;
  schema: T;
  params?: QontoQuery;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
};

/** What a Qonto call sends with: the HTTP client, and the sleep a retry waits with. */
type QontoTransport = Pick<QontoOptions, "client" | "proxyUrl" | "sleep">;

/** The response of `method` on `path`, as `schema` describes it; an empty body reads as `{}`. */
async function qontoRequest<T extends TSchema>(
  request: QontoRequest<T>,
  creds: QontoCreds,
  transport: QontoTransport = {},
): Promise<Static<T>> {
  const fetchFn = transport.client ?? proxyFetch(transport.proxyUrl ?? "");
  const url = qontoUrl(request.path, request.params);
  const headers = { ...authHeaders(creds), ...request.headers };
  const init = { method: request.method, headers, body: request.body ?? null };
  const last = await sendWithRetry(() => fetchFn(url, init), transport.sleep);
  const text = await last.text();
  if (last.status >= 400) {
    const detail = failureMessage(QONTO, last.status, text);
    throw QONTO.error(messageForStatus(last.status, detail, request.path), last.status);
  }
  return decodeBody(QONTO, request.schema, text || "{}");
}

function attachmentIds(row: Transaction): string[] {
  return (row.attachment_ids ?? []).filter(Boolean);
}

function transactionRow(row: Transaction, extra: string[] = []): string {
  return joinParts(
    row.id,
    row.settled_at,
    fmtNum(amountOf(row)),
    row.currency,
    row.side,
    row.label,
    row.operation_type,
    row.category,
    row.card_last_digits,
    row.note,
    row.reference,
    row.bank_account_id,
    ...extra,
  );
}

const ORGANIZATION = { method: "GET", path: "/v2/organization", schema: OrganizationResponse };

async function organization(creds: QontoCreds, options: Omit<QontoOptions, "login" | "secretKey">) {
  return (await qontoRequest(ORGANIZATION, creds, options)).organization ?? {};
}

export async function ping(creds: QontoCreds, options: Omit<QontoOptions, "login" | "secretKey"> = {}): Promise<string> {
  const name = (await organization(creds, options)).name;
  return name?.trim() ?? "";
}

/** `list_bank_accounts`: the organization's accounts, a row each. */
export async function listBankAccounts(options: QontoOptions): Promise<string> {
  const accounts = (await organization(options, options)).bank_accounts ?? [];
  const rows = accounts.map((account) =>
    joinParts(account.id, account.name, account.iban, account.currency, account.status),
  );
  return clipRows(rows, 100);
}

async function activeAccountIds(options: QontoOptions): Promise<string[]> {
  const accounts = (await organization(options, options)).bank_accounts ?? [];
  return accounts.flatMap((account) => (account.status === "active" && account.id ? [account.id] : []));
}

const TRANSACTIONS = { method: "GET", path: "/v2/transactions", schema: TransactionsResponse };

async function listAccountTransactions(options: QontoOptions, query: QontoQuery): Promise<Transaction[]> {
  const collected: Transaction[] = [];
  let page: string | number | undefined = 1;
  while (page !== undefined && page !== "") {
    const payload: TransactionsResponse = await qontoRequest({ ...TRANSACTIONS, params: { ...query, page } }, options, options);
    collected.push(...(payload.transactions ?? []));
    page = payload.meta?.next_page ?? undefined;
  }
  return collected;
}

type MissingQuery = {
  query: QontoQuery;
  minAmount: number | null;
  limit: number;
};

/** The transactions query, amount floor and row limit `list_missing_invoices` is called with. */
function missingQuery(scan: MissingInvoicesQuery, now: Date): MissingQuery {
  const range = settledRange(scan, now);
  const side = scan.side?.trim() || "debit";
  if (!isSide(side)) {
    throw new QontoError("side must be debit, credit, or both");
  }
  return {
    query: {
      "status[]": "completed",
      settled_at_from: range.from,
      settled_at_to: range.to,
      per_page: 100,
      sort_by: "settled_at:desc",
      with_attachments: false,
      side: side === "both" ? undefined : side,
    },
    minAmount: scan.min_amount ?? null,
    limit: Math.max(1, Math.min(100, scan.limit ?? MISSING_DISPLAY_CAP)),
  };
}

/** The account's transactions that miss their invoice, at or over the amount floor. */
async function accountMissing(options: QontoOptions, request: MissingQuery, accountId: string): Promise<Transaction[]> {
  const rows = await listAccountTransactions(options, { ...request.query, bank_account_id: accountId });
  return rows
    .map((row) => (row.bank_account_id ? row : { ...row, bank_account_id: accountId }))
    .filter((row) => isMissingInvoice(row))
    .filter((row) => request.minAmount === null || amountOf(row) >= request.minAmount);
}

/** `list_missing_invoices`: the count and total of the transactions that miss their invoice, and a row each. */
export async function listMissingInvoices(scan: MissingInvoicesQuery, options: QontoOptions): Promise<string> {
  const request = missingQuery(scan, options.now ? options.now() : new Date());
  const accountArg = scan.bank_account_id?.trim();
  const accountIds = accountArg ? [accountArg] : await activeAccountIds(options);
  const missing: Transaction[] = [];
  for (const accountId of accountIds) {
    missing.push(...(await accountMissing(options, request, accountId)));
  }
  missing.sort((left, right) => (right.settled_at ?? "").localeCompare(left.settled_at ?? ""));
  const total = missing.reduce((sum, row) => sum + amountOf(row), 0);
  const currencies = [...new Set(missing.map((row) => row.currency ?? "").filter(Boolean))];
  const summary = joinParts(`count=${missing.length}`, `total=${fmtNum(total)}`, currencies.length === 1 ? currencies[0] : currencies.join(","));
  if (!missing.length) {
    return summary;
  }
  return [summary, clipRows(missing.map((row) => transactionRow(row)), request.limit)].join("\n");
}

/** `value` trimmed; blank, it throws "<name> is required". */
function requiredText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new QontoError(`${name} is required`);
  }
  return trimmed;
}

async function getTransaction(id: string, options: QontoOptions): Promise<Transaction> {
  const transactionId = requiredText(id, "transaction_id");
  const request = { method: "GET", path: `/v2/transactions/${transactionId}`, schema: TransactionResponse };
  return (await qontoRequest(request, options, options)).transaction;
}

function formatTransaction(row: Transaction): string {
  const ids = attachmentIds(row);
  return transactionRow(row, [`attachments=${ids.length ? ids.join(",") : "-"}`]);
}

/** `get_transaction`: the transaction's row, with its attachments. */
export async function transactionDetail(transactionId: string, options: QontoOptions): Promise<string> {
  return formatTransaction(await getTransaction(transactionId, options));
}

function idempotencyKey(transactionId: string, filePath: string): string {
  const slot = `${transactionId}:${filePath}`;
  const existing = idempotencyKeys.get(slot);
  if (existing) {
    return existing;
  }
  const key = randomUUID();
  idempotencyKeys.set(slot, key);
  return key;
}

/**
 * The invoice an agent named in its workspace: a regular PDF, JPEG, or PNG file in its home,
 * not empty and within Qonto's size limit.
 */
export async function readInvoiceFile(
  workspaceDir: string,
  filePath: string,
): Promise<{ path: string; name: string; mime: string; content: Buffer }> {
  let read: { path: string; bytes: Buffer };
  try {
    read = await readAgentFile(workspaceDir, filePath, { maxBytes: MAX_ATTACHMENT_BYTES });
  } catch (error) {
    if (!(error instanceof AgentFileError)) {
      throw error;
    }
    if (error.problem === "missing" || error.problem === "not_file") {
      throw new QontoError(`file not found: ${filePath}`);
    }
    if (error.problem === "too_large") {
      throw new QontoError(
        `invalid file: size ${error.size} bytes exceeds Qonto's ${MAX_ATTACHMENT_BYTES} byte limit`,
      );
    }
    throw new QontoError(error.message);
  }
  const mime = MIME.get(path.extname(read.path).toLowerCase());
  if (!mime) {
    throw new QontoError("invalid file: only PDF, JPEG, and PNG are accepted");
  }
  if (!read.bytes.length) {
    throw new QontoError("invalid file: file is empty");
  }
  return { path: read.path, name: path.basename(read.path), mime, content: read.bytes };
}

async function pollAttachments(transactionId: string, options: QontoOptions): Promise<string[]> {
  let elapsed = 0;
  while (true) {
    const row = await getTransaction(transactionId, options);
    const ids = attachmentIds(row);
    if (ids.length) {
      return ids;
    }
    if (elapsed >= POLL_TIMEOUT_MS) {
      return [];
    }
    await sleepMs(POLL_INTERVAL_MS, options.sleep);
    elapsed += POLL_INTERVAL_MS;
  }
}

/** `upload_invoice`: the invoice attached to the transaction, unless it has one and `force` is off; and its attachments after. */
export async function uploadInvoice(invoice: InvoiceUpload, options: QontoOptions): Promise<string> {
  const transactionId = requiredText(invoice.transaction_id, "transaction_id");
  const filePath = requiredText(invoice.file_path, "file_path");
  if (!options.workspaceDir) {
    throw new QontoError("file_path is only available during an agent run");
  }
  const file = await readInvoiceFile(options.workspaceDir, filePath);
  const row = await getTransaction(transactionId, options);
  const existing = attachmentIds(row);
  if (existing.length && !invoice.force) {
    return joinParts("status=skipped_already_attached", `tx=${transactionId}`, `attachments=${existing.join(",")}`);
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.content)], { type: file.mime }), file.name);
  const upload = {
    method: "POST",
    path: `/v2/transactions/${transactionId}/attachments`,
    schema: UploadResponse,
    body: form,
    headers: { "X-Qonto-Idempotency-Key": idempotencyKey(transactionId, file.path) },
  };
  await qontoRequest(upload, options, options);
  const ids = await pollAttachments(transactionId, options);
  if (ids.length) {
    return joinParts("status=uploaded", `tx=${transactionId}`, `attachments=${ids.join(",")}`);
  }
  return joinParts("status=uploaded_pending_confirmation", `tx=${transactionId}`, "attachments=-");
}
