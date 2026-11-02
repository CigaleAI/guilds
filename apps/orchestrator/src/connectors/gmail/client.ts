import type { Static, TSchema } from "@sinclair/typebox";
import { AgentFileError, agentDisplayPath, writeAgentFile } from "../../lib/agent-file.js";
import type { JsonObject } from "../../lib/json.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { LIST_CAP, LIST_DEFAULT, clipRows, clipText, joinParts } from "../format.js";
import { decodeBody, failureMessage, type ConnectorApi } from "../response.js";
import type { AttachmentDownload, DraftPage, OutgoingMessage, ThreadSearch } from "./parameters.js";
import {
  AttachmentResponse,
  DraftListResponse,
  DraftResponse,
  ErrorBody,
  LabelsResponse,
  Message,
  ProfileResponse,
  SentResponse,
  ThreadListResponse,
  ThreadResponse,
  type DraftSummary,
  type Header,
  type MessagePart,
  type ThreadSummary,
} from "./responses.js";

export const API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const SNIPPET_CAP = 160;
export const BODY_CAP = 4_000;
export const ATTACHMENT_CAP = 25 * 1024 * 1024;
const METADATA_HEADERS = ["From", "To", "Subject", "Date"];

export class GmailError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GmailError";
    this.status = status;
  }
}

export type GmailOptions = {
  accessToken: string;
  client?: FetchFn;
  proxyUrl?: string;
  /** The agent's workspace when the call comes from a run. */
  workspaceDir?: string;
};

/**
 * A message part sent as a file. Its bytes are fetched by `attachmentId`, or carried inline in
 * `data` when the part is small.
 */
export type MessageAttachment = {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  data: string;
};

/** Text Gmail sent, trimmed; empty when it left the field out. */
function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** A message's headers by lowercased name, trimmed: the first of each name, blank ones left out. */
export function headerMap(headers: Header[] | null | undefined): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const item of headers ?? []) {
    const name = trimmed(item.name).toLowerCase();
    const value = trimmed(item.value);
    if (name && value && !mapped.has(name)) {
      mapped.set(name, value);
    }
  }
  return mapped;
}

export function decodeBodyData(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function partFilename(part: MessagePart): string {
  return trimmed(part.filename);
}

/** The inline body data of a part that is message text, not an attachment. */
function textData(part: MessagePart): string {
  return partFilename(part) ? "" : (part.body?.data ?? "");
}

/** A message's text, as its plain and its HTML parts carry it. */
type MessageText = { plain: string; html: string };

function collectText(part: MessagePart, into: MessageText): void {
  const mime = part.mimeType ?? "";
  const data = textData(part);
  if (data && mime.startsWith("text/plain")) {
    into.plain += decodeBodyData(data);
  } else if (data && mime.startsWith("text/html")) {
    into.html += decodeBodyData(data);
  }
  for (const child of part.parts ?? []) {
    collectText(child, into);
  }
}

function attachmentOf(part: MessagePart): MessageAttachment | null {
  const filename = partFilename(part);
  if (!filename) {
    return null;
  }
  return {
    partId: trimmed(part.partId),
    filename,
    mimeType: trimmed(part.mimeType),
    size: part.body?.size ?? 0,
    attachmentId: part.body?.attachmentId ?? "",
    data: part.body?.data ?? "",
  };
}

function collectAttachments(part: MessagePart, into: MessageAttachment[]): void {
  const attachment = attachmentOf(part);
  if (attachment) {
    into.push(attachment);
  }
  for (const child of part.parts ?? []) {
    collectAttachments(child, into);
  }
}

/** Every part of a message that carries a filename, in message order. */
export function messageAttachments(payload: MessagePart | null | undefined): MessageAttachment[] {
  const found: MessageAttachment[] = [];
  if (payload) {
    collectAttachments(payload, found);
  }
  return found;
}

function attachmentLine(attachment: MessageAttachment): string {
  return joinParts(
    "attachment",
    `part=${attachment.partId}`,
    attachment.filename,
    attachment.mimeType,
    `bytes=${attachment.size}`,
  );
}

export function messageBody(payload: MessagePart | null | undefined): string {
  if (!payload) {
    return "";
  }
  const collected: MessageText = { plain: "", html: "" };
  collectText(payload, collected);
  if (collected.plain.trim()) {
    return clipText(collected.plain, BODY_CAP);
  }
  if (collected.html.trim()) {
    return clipText(stripTags(collected.html), BODY_CAP);
  }
  return "";
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) {
    return subject;
  }
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function rfc2822Raw(fields: OutgoingMessage): string {
  const lines = [`To: ${fields.to}`];
  if (fields.cc) {
    lines.push(`Cc: ${fields.cc}`);
  }
  if (fields.bcc) {
    lines.push(`Bcc: ${fields.bcc}`);
  }
  lines.push(`Subject: ${encodeSubject(fields.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("");
  lines.push(fields.body);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** The rows a listing asks for: `limit`, `LIST_DEFAULT` when absent, kept between 1 and `LIST_CAP`. */
function pageSize(limit: number | undefined): number {
  return Math.max(1, Math.min(LIST_CAP, limit ?? LIST_DEFAULT));
}

/** `value` trimmed; blank, it throws "<name> is required". */
function requiredText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GmailError(`${name} is required`);
  }
  return trimmed;
}

/** The message of an error body, trimmed; null when it is blank or absent. */
function errorMessage(body: ErrorBody): string | null {
  return body.error.message?.trim() || null;
}

/** Gmail's API as the client reads its responses. */
const GMAIL: ConnectorApi<typeof ErrorBody> = {
  name: "Gmail",
  error: (message, status) => new GmailError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

function gmailUrl(path: string, params: Record<string, string | string[] | undefined> = {}): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/** One Gmail API call: `method` on `path` with its query and JSON body, the JSON response decoded with `schema`. */
type GmailRequest<T extends TSchema> = {
  method: string;
  path: string;
  schema: T;
  params?: Record<string, string | string[] | undefined>;
  body?: JsonObject;
};

/** The response of `method` on `path`, as `schema` describes it; an empty body reads as `{}`. */
async function gmailRequest<T extends TSchema>(request: GmailRequest<T>, options: GmailOptions): Promise<Static<T>> {
  const token = options.accessToken.trim();
  if (!token) {
    throw new GmailError("Gmail access token is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const init: RequestInit =
    request.body === undefined
      ? { method: request.method, headers: auth }
      : {
          method: request.method,
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(request.body),
        };
  const response = await fetchFn(gmailUrl(request.path, request.params), init);
  const text = await response.text();
  if (response.status >= 400) {
    throw GMAIL.error(failureMessage(GMAIL, response.status, text), response.status);
  }
  return decodeBody(GMAIL, request.schema, text || "{}");
}

/** The message as it is sent: each field trimmed, a blank copy line left out; a blank `to` throws. */
function composed(message: OutgoingMessage): OutgoingMessage {
  const to = requiredText(message.to, "to");
  const cc = message.cc?.trim();
  const bcc = message.bcc?.trim();
  return {
    to,
    subject: message.subject.trim(),
    body: message.body.trim(),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  };
}

function formatMessageHead(message: Message): string {
  const headers = headerMap(message.payload?.headers);
  return joinParts(
    message.id,
    headers.get("from"),
    headers.get("to"),
    headers.get("date"),
    headers.get("subject"),
  );
}

/** A message's headers, one line per attachment, then its text body. */
function formatMessage(message: Message): string {
  const attachments = messageAttachments(message.payload).map(attachmentLine);
  return [formatMessageHead(message), ...attachments, messageBody(message.payload)].filter(Boolean).join("\n");
}

function findAttachment(message: Message, partId: string): MessageAttachment {
  const found = messageAttachments(message.payload).find((attachment) => attachment.partId === partId);
  if (!found) {
    throw new GmailError(`message has no attachment at part ${partId}`, 422);
  }
  return found;
}

async function attachmentBytes(
  messageId: string,
  attachment: MessageAttachment,
  options: GmailOptions,
): Promise<Buffer> {
  if (attachment.size > ATTACHMENT_CAP) {
    throw new GmailError("attachment is larger than 25 MB", 422);
  }
  if (!attachment.attachmentId) {
    return Buffer.from(attachment.data, "base64url");
  }
  const path = `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`;
  const fetched = await gmailRequest({ method: "GET", path, schema: AttachmentResponse }, options);
  return Buffer.from(fetched.data ?? "", "base64url");
}

/** The attachment's filename as one name in the workspace root: no folders, controls, or leading dots. */
export function attachmentFileName(attachment: MessageAttachment): string {
  const name = attachment.filename.replace(/[\p{Cc}/\\]/gu, "-").replace(/^\.+/, "").trim();
  return (name || `attachment-${attachment.partId}`).slice(0, 200);
}

async function saveAttachment(workspaceDir: string, filePath: string, bytes: Buffer): Promise<string> {
  try {
    return await writeAgentFile(workspaceDir, filePath, bytes);
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new GmailError(error.message, 422);
    }
    throw error;
  }
}

export async function ping(accessToken: string, options: Omit<GmailOptions, "accessToken"> = {}): Promise<string> {
  const request = { method: "GET", path: "/users/me/profile", schema: ProfileResponse };
  const email = (await gmailRequest(request, { accessToken, ...options })).emailAddress;
  return trimmed(email) || "ok";
}

/** A thread's row: its id, the first message's sender, subject and date, and a snippet. */
async function threadRow(thread: ThreadSummary, options: GmailOptions): Promise<string | null> {
  const id = trimmed(thread.id);
  if (!id) {
    return null;
  }
  const detail = await gmailRequest(
    {
      method: "GET",
      path: `/users/me/threads/${encodeURIComponent(id)}`,
      schema: ThreadResponse,
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    },
    options,
  );
  const first = detail.messages?.[0];
  const headers = headerMap(first?.payload?.headers);
  return joinParts(
    id,
    headers.get("from"),
    headers.get("subject"),
    headers.get("date"),
    clipText(first?.snippet ?? thread.snippet, SNIPPET_CAP),
  );
}

/** `search_threads`: a page of the threads the query finds, a row each, and the next page's key. */
export async function searchThreads(search: ThreadSearch, options: GmailOptions): Promise<string> {
  const query = requiredText(search.query, "query");
  const limit = pageSize(search.limit);
  const listed = await gmailRequest(
    {
      method: "GET",
      path: "/users/me/threads",
      schema: ThreadListResponse,
      params: { q: query, maxResults: String(limit), pageToken: search.page_key?.trim() || undefined },
    },
    options,
  );
  const rows: string[] = [];
  for (const thread of (listed.threads ?? []).slice(0, limit)) {
    const row = await threadRow(thread, options);
    if (row !== null) {
      rows.push(row);
    }
  }
  const count = listed.resultSizeEstimate ?? rows.length;
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return joinParts(query, `n=${count}`);
  }
  const parts = [joinParts(query, `n=${count}`), body];
  const token = trimmed(listed.nextPageToken);
  if (token) {
    parts.push(`page=${token}`);
  }
  return parts.join("\n");
}

/** `get_thread`: every message of the thread, headers and text. */
export async function getThread(threadId: string, options: GmailOptions): Promise<string> {
  const id = requiredText(threadId, "thread_id");
  const path = `/users/me/threads/${encodeURIComponent(id)}`;
  const payload = await gmailRequest({ method: "GET", path, schema: ThreadResponse, params: { format: "full" } }, options);
  const messages = payload.messages ?? [];
  const blocks = messages.map(formatMessage);
  const intro = joinParts(payload.id ?? id, `messages=${messages.length}`);
  return [intro, ...blocks].filter(Boolean).join("\n---\n") || "no results";
}

async function fullMessage(messageId: string, options: GmailOptions): Promise<Message> {
  const path = `/users/me/messages/${encodeURIComponent(messageId)}`;
  return gmailRequest({ method: "GET", path, schema: Message, params: { format: "full" } }, options);
}

/** `get_message`: the message's headers, attachments and text. */
export async function getMessage(messageId: string, options: GmailOptions): Promise<string> {
  return formatMessage(await fullMessage(requiredText(messageId, "message_id"), options)) || "no results";
}

/** `download_attachment`: the attachment written in the run's workspace, and where. */
export async function downloadAttachment(download: AttachmentDownload, options: GmailOptions): Promise<string> {
  const workspaceDir = options.workspaceDir;
  if (!workspaceDir) {
    throw new GmailError("download_attachment is only available during an agent run", 422);
  }
  const messageId = requiredText(download.message_id, "message_id");
  const partId = requiredText(download.part_id, "part_id");
  const attachment = findAttachment(await fullMessage(messageId, options), partId);
  const bytes = await attachmentBytes(messageId, attachment, options);
  const filePath = download.file_path?.trim() || attachmentFileName(attachment);
  const resolved = await saveAttachment(workspaceDir, filePath, bytes);
  return joinParts(
    `file_path=${agentDisplayPath(workspaceDir, resolved)}`,
    attachment.mimeType,
    `bytes=${bytes.length}`,
  );
}

/** `list_labels`: the mailbox's labels, a row each. */
export async function listLabels(options: GmailOptions): Promise<string> {
  const payload = await gmailRequest({ method: "GET", path: "/users/me/labels", schema: LabelsResponse }, options);
  const rows = (payload.labels ?? []).map((label) => joinParts(label.id, label.name, label.type));
  return clipRows(rows.filter(Boolean), 100);
}

/** A draft's row: its id, its message's id, and the message's recipient and subject. */
async function draftRow(draft: DraftSummary, options: GmailOptions): Promise<string | null> {
  const id = trimmed(draft.id);
  if (!id) {
    return null;
  }
  const detail = await gmailRequest(
    {
      method: "GET",
      path: `/users/me/drafts/${encodeURIComponent(id)}`,
      schema: DraftResponse,
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    },
    options,
  );
  const headers = headerMap(detail.message?.payload?.headers);
  return joinParts(id, detail.message?.id, headers.get("to"), headers.get("subject"));
}

/** `list_drafts`: a page of the drafts, a row each, and the next page's key. */
export async function listDrafts(page: DraftPage, options: GmailOptions): Promise<string> {
  const limit = pageSize(page.limit);
  const listed = await gmailRequest(
    {
      method: "GET",
      path: "/users/me/drafts",
      schema: DraftListResponse,
      params: { maxResults: String(limit), pageToken: page.page_key?.trim() || undefined },
    },
    options,
  );
  const rows: string[] = [];
  for (const draft of (listed.drafts ?? []).slice(0, limit)) {
    const row = await draftRow(draft, options);
    if (row !== null) {
      rows.push(row);
    }
  }
  const body = clipRows(rows, limit);
  const token = trimmed(listed.nextPageToken);
  if (body === "no results") {
    return body;
  }
  return token ? `${body}\npage=${token}` : body;
}

/** `create_draft`: the message saved as a draft, and the ids Gmail gave it. */
export async function createDraft(message: OutgoingMessage, options: GmailOptions): Promise<string> {
  const body = { message: { raw: rfc2822Raw(composed(message)) } };
  const payload = await gmailRequest({ method: "POST", path: "/users/me/drafts", schema: DraftResponse, body }, options);
  return joinParts(`draft=${payload.id ?? ""}`, `message=${payload.message?.id ?? ""}`) || "ok";
}

/** `send_message`: the message sent, and the ids Gmail gave it. */
export async function sendMessage(message: OutgoingMessage, options: GmailOptions): Promise<string> {
  const body = { raw: rfc2822Raw(composed(message)) };
  const payload = await gmailRequest({ method: "POST", path: "/users/me/messages/send", schema: SentResponse, body }, options);
  return joinParts(`id=${payload.id ?? ""}`, `thread=${payload.threadId ?? ""}`) || "ok";
}
