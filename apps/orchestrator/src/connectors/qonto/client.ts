import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentFileError, readAgentFile } from "../../lib/agent-file.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { argStr, clipRows, fmtNum, joinParts } from "../format.js";

export const API_BASE = "https://thirdparty.qonto.com";
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MISSING_DISPLAY_CAP = 50;
export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 60_000;
const MAX_TRIES = 3;
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

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

export function isMissingInvoice(row: Record<string, unknown>): boolean {
  const ids = row.attachment_ids;
  if (Array.isArray(ids) && ids.length) {
    return false;
  }
  if (row.attachment_required !== true) {
    return false;
  }
  return row.attachment_lost !== true;
}

function asAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replaceAll(" ", "").replace(",", "."));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
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

function settledRange(arguments_: Record<string, unknown>, now: Date): { from: string; to: string } {
  const today = utcDay(now);
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 90);
  const fromArg = argStr(arguments_, "settled_from");
  const toArg = argStr(arguments_, "settled_to");
  return {
    from: fromArg ? isoDate(fromArg, "settled_from") : defaultFrom.toISOString().slice(0, 10),
    to: toArg ? isoDate(toArg, "settled_to") : today.toISOString().slice(0, 10),
  };
}

function qontoUrl(pathName: string, params: Record<string, string | boolean | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      search.set(key, value ? "true" : "false");
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `${API_BASE}${pathName}?${encoded}` : `${API_BASE}${pathName}`;
}

function authHeaders(creds: QontoCreds): Record<string, string> {
  const login = creds.login.trim();
  const secretKey = creds.secretKey.trim();
  if (!login || !secretKey) {
    throw new QontoError("Qonto login and secret key are required", 401);
  }
  return { Authorization: `${login}:${secretKey}`, Accept: "application/json" };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return text.trim() || `Qonto HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const errors = (payload as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object" && !Array.isArray(errors[0])) {
      const first = errors[0] as { detail?: unknown; message?: unknown };
      const detail = first.detail ?? first.message;
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
    }
  }
  return `Qonto HTTP ${response.status}`;
}

function messageForStatus(status: number, detail: string, requestPath: string): string {
  if (status === 401) {
    return "bad credentials";
  }
  if (status === 404 && requestPath.startsWith("/v2/transactions/")) {
    return "unknown transaction";
  }
  if (status === 422) {
    return detail ? `invalid file: ${detail}` : "invalid file";
  }
  return detail || `Qonto HTTP ${status}`;
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

async function qontoRequest(
  method: string,
  requestPath: string,
  creds: QontoCreds,
  options: {
    client?: FetchFn;
    proxyUrl?: string;
    params?: Record<string, string | boolean | number | undefined>;
    body?: RequestInit["body"];
    extraHeaders?: Record<string, string>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<unknown> {
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const url = qontoUrl(requestPath, options.params);
  const headers: Record<string, string> = { ...authHeaders(creds), ...options.extraHeaders };
  let wait = 1_000;
  let last: Response | null = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const response = await fetchFn(url, { method, headers, body: options.body ?? null });
    last = response;
    if (response.status !== 429 && response.status < 500) {
      break;
    }
    if (attempt === MAX_TRIES) {
      break;
    }
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : wait;
    await sleepMs(delay, options.sleep);
    wait *= 2;
  }
  if (!last) {
    throw new QontoError("Qonto request failed");
  }
  if (last.status >= 400) {
    const detail = await errorDetail(last);
    throw new QontoError(messageForStatus(last.status, detail, requestPath), last.status);
  }
  const text = await last.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new QontoError("Qonto returned a non-JSON body");
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QontoError(`unexpected ${label} response`);
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function attachmentIds(row: Record<string, unknown>): string[] {
  const ids = row.attachment_ids;
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.map((id) => String(id)).filter(Boolean);
}

function transactionRow(row: Record<string, unknown>, extra: string[] = []): string {
  return joinParts(
    row.id,
    row.settled_at,
    fmtNum(asAmount(row.amount)),
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

export async function ping(creds: QontoCreds, options: Omit<QontoOptions, "login" | "secretKey"> = {}): Promise<string> {
  const payload = asObject(await qontoRequest("GET", "/v2/organization", creds, options), "organization");
  const organization = asObject(payload.organization ?? {}, "organization");
  const name = organization.name;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

async function listBankAccounts(options: QontoOptions): Promise<string> {
  const payload = asObject(
    await qontoRequest("GET", "/v2/organization", options, options),
    "organization",
  );
  const organization = asObject(payload.organization ?? {}, "organization");
  const rows = asList(organization.bank_accounts).map((account) =>
    joinParts(account.id, account.name, account.iban, account.currency, account.status),
  );
  return clipRows(rows, 100);
}

async function activeAccountIds(options: QontoOptions): Promise<string[]> {
  const payload = asObject(
    await qontoRequest("GET", "/v2/organization", options, options),
    "organization",
  );
  const organization = asObject(payload.organization ?? {}, "organization");
  return asList(organization.bank_accounts)
    .filter((account) => account.status === "active" && typeof account.id === "string" && account.id)
    .map((account) => String(account.id));
}

async function listAccountTransactions(
  options: QontoOptions,
  query: Record<string, string | boolean | number | undefined>,
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  let page: string | number | undefined = 1;
  while (page !== undefined && page !== null && page !== "") {
    const payload = asObject(
      await qontoRequest("GET", "/v2/transactions", options, { ...options, params: { ...query, page } }),
      "transactions",
    );
    collected.push(...asList(payload.transactions));
    const meta =
      payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
        ? (payload.meta as Record<string, unknown>)
        : {};
    const next = meta.next_page;
    page = next === undefined || next === null || next === "" ? undefined : (next as string | number);
  }
  return collected;
}

async function listMissingInvoices(arguments_: Record<string, unknown>, options: QontoOptions): Promise<string> {
  const now = options.now ? options.now() : new Date();
  const range = settledRange(arguments_, now);
  const side = argStr(arguments_, "side") || "debit";
  if (side !== "debit" && side !== "credit" && side !== "both") {
    throw new QontoError("side must be debit, credit, or both");
  }
  const minRaw = arguments_.min_amount;
  const minAmount = minRaw === undefined || minRaw === null || minRaw === "" ? null : asAmount(minRaw);
  const accountArg = argStr(arguments_, "bank_account_id");
  const accountIds = accountArg ? [accountArg] : await activeAccountIds(options);
  const query: Record<string, string | boolean | number | undefined> = {
    "status[]": "completed",
    settled_at_from: range.from,
    settled_at_to: range.to,
    per_page: 100,
    sort_by: "settled_at:desc",
    with_attachments: false,
  };
  if (side !== "both") {
    query.side = side;
  }
  const missing: Array<Record<string, unknown>> = [];
  for (const accountId of accountIds) {
    const rows = await listAccountTransactions(options, { ...query, bank_account_id: accountId });
    for (const row of rows) {
      const withAccount = row.bank_account_id ? row : { ...row, bank_account_id: accountId };
      if (!isMissingInvoice(withAccount)) {
        continue;
      }
      if (minAmount !== null && asAmount(withAccount.amount) < minAmount) {
        continue;
      }
      missing.push(withAccount);
    }
  }
  missing.sort((left, right) => String(right.settled_at ?? "").localeCompare(String(left.settled_at ?? "")));
  const total = missing.reduce((sum, row) => sum + asAmount(row.amount), 0);
  const currencies = [...new Set(missing.map((row) => String(row.currency ?? "")).filter(Boolean))];
  const limitRaw = arguments_.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.trunc(limitRaw)))
      : MISSING_DISPLAY_CAP;
  const summary = joinParts(`count=${missing.length}`, `total=${fmtNum(total)}`, currencies.length === 1 ? currencies[0] : currencies.join(","));
  if (!missing.length) {
    return summary;
  }
  return [summary, clipRows(missing.map((row) => transactionRow(row)), limit)].join("\n");
}

async function getTransaction(arguments_: Record<string, unknown>, options: QontoOptions): Promise<Record<string, unknown>> {
  const transactionId = argStr(arguments_, "transaction_id");
  if (!transactionId) {
    throw new QontoError("transaction_id is required");
  }
  const payload = asObject(
    await qontoRequest("GET", `/v2/transactions/${transactionId}`, options, options),
    "transaction",
  );
  return asObject(payload.transaction, "transaction");
}

function formatTransaction(row: Record<string, unknown>): string {
  const ids = attachmentIds(row);
  return transactionRow(row, [`attachments=${ids.length ? ids.join(",") : "-"}`]);
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
 * The invoice an agent named in its workspace: a regular PDF, JPEG, or PNG file under /home/agent,
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
  const mime = MIME[path.extname(read.path).toLowerCase()];
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
    const row = await getTransaction({ transaction_id: transactionId }, options);
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

async function uploadInvoice(arguments_: Record<string, unknown>, options: QontoOptions): Promise<string> {
  const transactionId = argStr(arguments_, "transaction_id");
  const filePath = argStr(arguments_, "file_path");
  if (!transactionId) {
    throw new QontoError("transaction_id is required");
  }
  if (!filePath) {
    throw new QontoError("file_path is required");
  }
  if (!options.workspaceDir) {
    throw new QontoError("file_path is only available during an agent run");
  }
  const file = await readInvoiceFile(options.workspaceDir, filePath);
  const row = await getTransaction({ transaction_id: transactionId }, options);
  const existing = attachmentIds(row);
  const force = arguments_.force === true;
  if (existing.length && !force) {
    return joinParts("status=skipped_already_attached", `tx=${transactionId}`, `attachments=${existing.join(",")}`);
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.content)], { type: file.mime }), file.name);
  await qontoRequest("POST", `/v2/transactions/${transactionId}/attachments`, options, {
    ...options,
    body: form,
    extraHeaders: { "X-Qonto-Idempotency-Key": idempotencyKey(transactionId, file.path) },
  });
  const ids = await pollAttachments(transactionId, options);
  if (ids.length) {
    return joinParts("status=uploaded", `tx=${transactionId}`, `attachments=${ids.join(",")}`);
  }
  return joinParts("status=uploaded_pending_confirmation", `tx=${transactionId}`, "attachments=-");
}

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: QontoOptions,
): Promise<string> {
  if (name === "list_bank_accounts") {
    return listBankAccounts(options);
  }
  if (name === "list_missing_invoices") {
    return listMissingInvoices(arguments_, options);
  }
  if (name === "get_transaction") {
    return formatTransaction(await getTransaction(arguments_, options));
  }
  if (name === "upload_invoice") {
    return uploadInvoice(arguments_, options);
  }
  throw new QontoError(`unknown Qonto tool: ${name}`);
}
