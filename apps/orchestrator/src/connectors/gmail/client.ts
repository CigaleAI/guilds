import { AgentFileError, agentDisplayPath, writeAgentFile } from "../../lib/agent-file.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { argStr, clipRows, clipText, joinParts, rowLimit } from "../format.js";

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

export function headerMap(headers: unknown): Record<string, string> {
  const mapped: Record<string, string> = {};
  if (!Array.isArray(headers)) {
    return mapped;
  }
  for (const item of headers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const name = String((item as { name?: unknown }).name ?? "").trim().toLowerCase();
    const value = String((item as { value?: unknown }).value ?? "").trim();
    if (name && value && mapped[name] === undefined) {
      mapped[name] = value;
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function partBody(part: Record<string, unknown>): Record<string, unknown> {
  const body = part.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function partFilename(part: Record<string, unknown>): string {
  return String(part.filename ?? "").trim();
}

/** The inline body data of a part that is message text, not an attachment. */
function textData(part: Record<string, unknown>): string {
  if (partFilename(part)) {
    return "";
  }
  const data = partBody(part).data;
  return typeof data === "string" ? data : "";
}

function collectText(part: Record<string, unknown>, into: { plain: string; html: string }): void {
  const mime = String(part.mimeType ?? "");
  const data = textData(part);
  if (data && mime.startsWith("text/plain")) {
    into.plain += decodeBodyData(data);
  } else if (data && mime.startsWith("text/html")) {
    into.html += decodeBodyData(data);
  }
  for (const child of asList(part.parts)) {
    collectText(child, into);
  }
}

function attachmentOf(part: Record<string, unknown>): MessageAttachment | null {
  const filename = partFilename(part);
  if (!filename) {
    return null;
  }
  const body = partBody(part);
  return {
    partId: String(part.partId ?? "").trim(),
    filename,
    mimeType: String(part.mimeType ?? "").trim(),
    size: typeof body.size === "number" ? body.size : 0,
    attachmentId: typeof body.attachmentId === "string" ? body.attachmentId : "",
    data: typeof body.data === "string" ? body.data : "",
  };
}

function collectAttachments(part: Record<string, unknown>, into: MessageAttachment[]): void {
  const attachment = attachmentOf(part);
  if (attachment) {
    into.push(attachment);
  }
  for (const child of asList(part.parts)) {
    collectAttachments(child, into);
  }
}

/** Every part of a message that carries a filename, in message order. */
export function messageAttachments(payload: Record<string, unknown> | null): MessageAttachment[] {
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

export function messageBody(payload: Record<string, unknown> | null): string {
  if (!payload) {
    return "";
  }
  const collected = { plain: "", html: "" };
  collectText(payload, collected);
  if (collected.plain.trim()) {
    return clipText(collected.plain, BODY_CAP);
  }
  if (collected.html.trim()) {
    return clipText(stripTags(collected.html), BODY_CAP);
  }
  return "";
}

function messagePayload(message: Record<string, unknown>): Record<string, unknown> | null {
  const payload = message.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) {
    return subject;
  }
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function rfc2822Raw(fields: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
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

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GmailError(`unexpected ${label} response`);
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

function pageToken(payload: Record<string, unknown>): string {
  const token = payload.nextPageToken;
  return typeof token === "string" && token.trim() ? token.trim() : "";
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return text.trim() || `Gmail HTTP ${response.status}`;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }
  return `Gmail HTTP ${response.status}`;
}

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

async function gmailRequest(
  method: string,
  path: string,
  options: GmailOptions,
  extra: { params?: Record<string, string | string[] | undefined>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const token = options.accessToken.trim();
  if (!token) {
    throw new GmailError("Gmail access token is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (extra.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(extra.body);
  }
  const response = await fetchFn(gmailUrl(path, extra.params), init);
  if (response.status >= 400) {
    throw new GmailError(await errorDetail(response), response.status);
  }
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return asObject(JSON.parse(text), path);
  } catch (error) {
    if (error instanceof GmailError) {
      throw error;
    }
    throw new GmailError("Gmail returned a non-JSON body");
  }
}

function composeFields(arguments_: Record<string, unknown>): {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
} {
  const to = argStr(arguments_, "to");
  const subject = argStr(arguments_, "subject");
  const body = argStr(arguments_, "body");
  if (!to) {
    throw new GmailError("to is required");
  }
  const fields: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
    to,
    subject,
    body,
  };
  const cc = argStr(arguments_, "cc");
  const bcc = argStr(arguments_, "bcc");
  if (cc) {
    fields.cc = cc;
  }
  if (bcc) {
    fields.bcc = bcc;
  }
  return fields;
}

function formatMessageHead(message: Record<string, unknown>): string {
  const payload = messagePayload(message);
  const headers = headerMap(payload?.headers);
  return joinParts(
    message.id,
    headers.from,
    headers.to,
    headers.date,
    headers.subject,
  );
}

/** A message's headers, one line per attachment, then its text body. */
function formatMessage(message: Record<string, unknown>): string {
  const payload = messagePayload(message);
  const attachments = messageAttachments(payload).map(attachmentLine);
  return [formatMessageHead(message), ...attachments, messageBody(payload)].filter(Boolean).join("\n");
}

function requiredArg(arguments_: Record<string, unknown>, key: string): string {
  const value = argStr(arguments_, key);
  if (!value) {
    throw new GmailError(`${key} is required`);
  }
  return value;
}

function findAttachment(message: Record<string, unknown>, partId: string): MessageAttachment {
  const found = messageAttachments(messagePayload(message)).find((attachment) => attachment.partId === partId);
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
  const fetched = await gmailRequest(
    "GET",
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
    options,
  );
  return Buffer.from(typeof fetched.data === "string" ? fetched.data : "", "base64url");
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
  const payload = await gmailRequest("GET", "/users/me/profile", { accessToken, ...options });
  const email = payload.emailAddress;
  return typeof email === "string" && email.trim() ? email.trim() : "ok";
}

export async function searchThreadsTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new GmailError("query is required");
  }
  const limit = rowLimit(arguments_);
  const listed = await gmailRequest("GET", "/users/me/threads", options, {
    params: {
      q: query,
      maxResults: String(limit),
      pageToken: argStr(arguments_, "page_key") || undefined,
    },
  });
  const threads = asList(listed.threads);
  const rows: string[] = [];
  for (const thread of threads.slice(0, limit)) {
    const id = String(thread.id ?? "").trim();
    if (!id) {
      continue;
    }
    const detail = await gmailRequest("GET", `/users/me/threads/${encodeURIComponent(id)}`, options, {
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    });
    const messages = asList(detail.messages);
    const first = messages[0] ?? {};
    const headers = headerMap(messagePayload(first)?.headers);
    rows.push(
      joinParts(
        id,
        headers.from,
        headers.subject,
        headers.date,
        clipText(first.snippet ?? thread.snippet, SNIPPET_CAP),
      ),
    );
  }
  const estimate = listed.resultSizeEstimate;
  const count = typeof estimate === "number" ? estimate : rows.length;
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return joinParts(query, `n=${count}`);
  }
  const parts = [joinParts(query, `n=${count}`), body];
  const token = pageToken(listed);
  if (token) {
    parts.push(`page=${token}`);
  }
  return parts.join("\n");
}

export async function getThreadTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const threadId = argStr(arguments_, "thread_id");
  if (!threadId) {
    throw new GmailError("thread_id is required");
  }
  const payload = await gmailRequest("GET", `/users/me/threads/${encodeURIComponent(threadId)}`, options, {
    params: { format: "full" },
  });
  const messages = asList(payload.messages);
  const blocks = messages.map(formatMessage);
  const intro = joinParts(payload.id ?? threadId, `messages=${messages.length}`);
  return [intro, ...blocks].filter(Boolean).join("\n---\n") || "no results";
}

export async function getMessageTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const messageId = argStr(arguments_, "message_id");
  if (!messageId) {
    throw new GmailError("message_id is required");
  }
  const payload = await gmailRequest("GET", `/users/me/messages/${encodeURIComponent(messageId)}`, options, {
    params: { format: "full" },
  });
  return formatMessage(payload) || "no results";
}

export async function downloadAttachmentTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const workspaceDir = options.workspaceDir;
  if (!workspaceDir) {
    throw new GmailError("download_attachment is only available during an agent run", 422);
  }
  const messageId = requiredArg(arguments_, "message_id");
  const partId = requiredArg(arguments_, "part_id");
  const message = await gmailRequest("GET", `/users/me/messages/${encodeURIComponent(messageId)}`, options, {
    params: { format: "full" },
  });
  const attachment = findAttachment(message, partId);
  const bytes = await attachmentBytes(messageId, attachment, options);
  const filePath = argStr(arguments_, "file_path") || attachmentFileName(attachment);
  const resolved = await saveAttachment(workspaceDir, filePath, bytes);
  return joinParts(
    `file_path=${agentDisplayPath(workspaceDir, resolved)}`,
    attachment.mimeType,
    `bytes=${bytes.length}`,
  );
}

export async function listLabelsTool(
  _arguments: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const payload = await gmailRequest("GET", "/users/me/labels", options);
  const rows = asList(payload.labels).map((label) =>
    joinParts(label.id, label.name, label.type),
  );
  return clipRows(rows.filter(Boolean), 100);
}

export async function listDraftsTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const limit = rowLimit(arguments_);
  const listed = await gmailRequest("GET", "/users/me/drafts", options, {
    params: {
      maxResults: String(limit),
      pageToken: argStr(arguments_, "page_key") || undefined,
    },
  });
  const rows: string[] = [];
  for (const draft of asList(listed.drafts).slice(0, limit)) {
    const id = String(draft.id ?? "").trim();
    if (!id) {
      continue;
    }
    const detail = await gmailRequest("GET", `/users/me/drafts/${encodeURIComponent(id)}`, options, {
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    });
    const message =
      detail.message && typeof detail.message === "object" && !Array.isArray(detail.message)
        ? (detail.message as Record<string, unknown>)
        : {};
    const headers = headerMap(messagePayload(message)?.headers);
    rows.push(joinParts(id, message.id, headers.to, headers.subject));
  }
  const body = clipRows(rows, limit);
  const token = pageToken(listed);
  if (body === "no results") {
    return body;
  }
  return token ? `${body}\npage=${token}` : body;
}

export async function createDraftTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const payload = await gmailRequest("POST", "/users/me/drafts", options, {
    body: { message: { raw: rfc2822Raw(composeFields(arguments_)) } },
  });
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : {};
  return joinParts(`draft=${payload.id ?? ""}`, `message=${message.id ?? ""}`) || "ok";
}

export async function sendMessageTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const payload = await gmailRequest("POST", "/users/me/messages/send", options, {
    body: { raw: rfc2822Raw(composeFields(arguments_)) },
  });
  return joinParts(`id=${payload.id ?? ""}`, `thread=${payload.threadId ?? ""}`) || "ok";
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: GmailOptions) => Promise<string>> = {
  search_threads: searchThreadsTool,
  get_thread: getThreadTool,
  get_message: getMessageTool,
  download_attachment: downloadAttachmentTool,
  list_labels: listLabelsTool,
  list_drafts: listDraftsTool,
  create_draft: createDraftTool,
  send_message: sendMessageTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new GmailError(`unknown Gmail tool ${name}`);
  }
  return handler(arguments_, options);
}
