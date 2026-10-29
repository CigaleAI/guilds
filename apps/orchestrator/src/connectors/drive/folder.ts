import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decode } from "../../lib/decode.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import {
  DriveFile,
  ErrorBody,
  FileList,
  JsonObject,
  ListedFile,
  Reasoned,
  SharedDrive,
  TextPart,
} from "./responses.js";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_MY_DRIVE = "root";
export const DRIVE_SHARED_WITH_ME = "shared";
export const DRIVE_SHARED_DRIVES = "drives";
const DRIVE_ID_PREFIX = "drive:";

export class DriveFolderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DriveFolderError";
  }
}

export type DriveClientOptions = { client?: FetchFn | undefined; proxyUrl?: string | undefined };

/** The client options of a call scoped to the connected folder, with the login that makes it. */
export type ScopedDrive = DriveClientOptions & { accessToken: string; folderId: string };

export type DriveFolder = { id: string; name: string };

/** One Drive API request: its URL, the schema of its response, and its method and body. */
export type DriveRequest<T extends TSchema> = {
  url: string;
  schema: T;
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
};

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
};

type McpFile = { id: string; title: string; parentId: string; mimeType: string };

const UnknownList = Type.Array(Type.Unknown());

function driveFetch(options: DriveClientOptions): FetchFn {
  return options.client ?? proxyFetch(options.proxyUrl ?? "");
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isJsonObject(value: unknown): value is JsonObject {
  return Value.Check(JsonObject, value);
}

/** The folder id a Drive link names, or null when `text` is not a Drive link. */
function folderIdFromUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Plain folder ids are not URLs.
    return null;
  }
  if (url.hostname !== "drive.google.com" && !url.hostname.endsWith(".google.com")) {
    return null;
  }
  const folder = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folder?.[1]) {
    return folder[1];
  }
  return url.searchParams.get("id")?.trim() || null;
}

export function parseDriveFolderRef(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new DriveFolderError("Google Drive Connect requires picking one folder");
  }
  const trimmed = raw.trim();
  const id = folderIdFromUrl(trimmed) ?? bareFolderId(trimmed);
  if (id) {
    return id;
  }
  throw new DriveFolderError("Google Drive Connect requires a Drive folder link or id");
}

/** The folder id `text` is on its own, with or without the Drive id prefix; null when it is not one. */
function bareFolderId(text: string): string | null {
  const prefixed = text.startsWith(DRIVE_ID_PREFIX) ? text.slice(DRIVE_ID_PREFIX.length) : text;
  return /^[a-zA-Z0-9_-]+$/.test(prefixed) ? prefixed : null;
}

/** A bare id shorter than this is a folder name to search for, not an id. */
const SHORT_ID_LENGTH = 20;

/**
 * The folder a lookup query names outright: a pasted Drive folder link, or a bare id of at least
 * 20 characters. Null when the query is a folder name to search for.
 */
export function pastedDriveFolderRef(query: string): string | null {
  const trimmed = query.trim();
  const linked = folderIdFromUrl(trimmed);
  if (linked) {
    return linked;
  }
  const id = bareFolderId(trimmed);
  return id !== null && id.length >= SHORT_ID_LENGTH ? id : null;
}

function reasonOf(item: unknown): string {
  return Value.Check(Reasoned, item) ? item.reason : "";
}

/** The reason of the first entry of `errors`. */
function errorsReason(errors: unknown): string {
  return Value.Check(UnknownList, errors) ? reasonOf(errors[0]) : "";
}

/** The first reason among `details`. */
function detailsReason(details: unknown): string {
  if (!Value.Check(UnknownList, details)) {
    return "";
  }
  for (const item of details) {
    const reason = reasonOf(item);
    if (reason) {
      return reason;
    }
  }
  return "";
}

function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The message and reason of a Google error body: the reason of `details`, else of `errors`, else `status`. */
function googleDriveError(text: string): { message: string; reason: string } {
  const payload = parsedOrNull(text);
  if (!Value.Check(ErrorBody, payload)) {
    return { message: "", reason: "" };
  }
  const error = payload.error;
  const status = typeof error.status === "string" ? error.status : "";
  return {
    message: typeof error.message === "string" ? error.message : "",
    reason: detailsReason(error.details) || errorsReason(error.errors) || status,
  };
}

function driveLookupError(status: number, text: string): string {
  if (status === 404) {
    return "picked folder is not available to this login";
  }
  const { message, reason } = googleDriveError(text);
  if (reason === "accessNotConfigured" || /API has not been used/i.test(message)) {
    return "Drive API is not enabled on this Google Cloud project";
  }
  if (
    reason === "insufficientPermissions" ||
    reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
    /insufficient authentication scopes/i.test(message)
  ) {
    return "Google Drive login is missing full Drive access. Add the drive scope on the Cloud OAuth consent screen, then Disconnect and Connect Drive again.";
  }
  if (message) {
    return status === 403 ? `Drive folder lookup was denied: ${message}` : `Drive folder lookup failed: ${message}`;
  }
  return `Drive folder lookup failed: ${status}`;
}

function unexpected(problem: string): DriveFolderError {
  return new DriveFolderError(`Drive returned an unexpected response at ${problem}`);
}

/** The response to `request`, as its schema describes it. */
export async function driveJson<T extends TSchema>(
  accessToken: string,
  request: DriveRequest<T>,
  options: DriveClientOptions,
): Promise<Static<T>> {
  const init = request.init ?? {};
  const response = await driveFetch(options)(request.url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new DriveFolderError(driveLookupError(response.status, text));
  }
  const payload = parsedOrNull(text);
  if (!isJsonObject(payload)) {
    throw new DriveFolderError("Drive folder lookup returned a non-object");
  }
  return decode(request.schema, payload, unexpected);
}

export async function driveBytes(
  accessToken: string,
  url: string,
  options: DriveClientOptions,
): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await driveFetch(options)(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status >= 400) {
    throw new DriveFolderError(driveLookupError(response.status, await response.text()));
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function loadDriveFile(
  accessToken: string,
  fileId: string,
  options: DriveClientOptions = {},
): Promise<DriveFileMeta> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    "?fields=id,name,mimeType,parents&supportsAllDrives=true";
  const payload = await driveJson(accessToken, { url, schema: DriveFile }, options);
  if (!payload.id) {
    throw new DriveFolderError("Drive folder lookup is missing id or name");
  }
  return {
    id: payload.id,
    name: payload.name ?? "",
    mimeType: payload.mimeType ?? "",
    parents: (payload.parents ?? []).filter(Boolean),
  };
}

async function loadSharedDrive(
  accessToken: string,
  driveId: string,
  options: DriveClientOptions = {},
): Promise<DriveFolder> {
  const url = `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(driveId)}?fields=id,name`;
  const payload = await driveJson(accessToken, { url, schema: SharedDrive }, options);
  const name = payload.name?.trim();
  if (!payload.id || !name) {
    throw new DriveFolderError("Drive folder lookup is missing id or name");
  }
  return { id: payload.id, name };
}

function foldersFromFiles(payload: FileList): DriveFolder[] {
  const folders: DriveFolder[] = [];
  for (const row of payload.files ?? []) {
    const name = row.name?.trim();
    if (row.id && name) {
      folders.push({ id: row.id, name });
    }
  }
  folders.sort((left, right) => left.name.localeCompare(right.name));
  return folders;
}

export async function loadDriveFolder(
  accessToken: string,
  folderId: string,
  options: DriveClientOptions = {},
): Promise<DriveFolder> {
  try {
    const row = await loadDriveFile(accessToken, folderId, options);
    if (row.mimeType !== DRIVE_FOLDER_MIME) {
      throw new DriveFolderError("Google Drive Connect requires picking one folder");
    }
    if (!row.name.trim()) {
      throw new DriveFolderError("Drive folder lookup is missing id or name");
    }
    return { id: row.id, name: row.name.trim() };
  } catch (error) {
    if (error instanceof DriveFolderError && error.message === "Google Drive Connect requires picking one folder") {
      throw error;
    }
    return loadSharedDrive(accessToken, folderId, options);
  }
}

export async function loadDriveRootId(
  accessToken: string,
  options: DriveClientOptions = {},
): Promise<string> {
  const url = "https://www.googleapis.com/drive/v3/files/root?fields=id&supportsAllDrives=true";
  const payload = await driveJson(accessToken, { url, schema: DriveFile }, options);
  if (!payload.id) {
    throw new DriveFolderError("Drive root lookup is missing id");
  }
  return payload.id;
}

export async function assertPickedDriveFolder(
  accessToken: string,
  folderId: string,
  options: DriveClientOptions = {},
): Promise<DriveFolder> {
  const id = folderId.startsWith(DRIVE_ID_PREFIX) ? folderId.slice(DRIVE_ID_PREFIX.length) : folderId;
  if (id === DRIVE_MY_DRIVE || id === DRIVE_SHARED_WITH_ME || id === DRIVE_SHARED_DRIVES) {
    throw new DriveFolderError("Google Drive Connect requires a folder inside Drive, not My Drive");
  }
  const folder = await loadDriveFolder(accessToken, id, options);
  const rootId = await loadDriveRootId(accessToken, options);
  if (folder.id === rootId) {
    throw new DriveFolderError("Google Drive Connect requires a folder inside Drive, not My Drive");
  }
  return folder;
}

/** Folders whose name contains `query`, across My Drive, shared folders, and shared drives. */
export async function searchDriveFolders(
  accessToken: string,
  query: string,
  options: DriveClientOptions = {},
): Promise<DriveFolder[]> {
  const params = new URLSearchParams({
    fields: "files(id,name)",
    pageSize: "20",
    corpora: "allDrives",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    q: `mimeType = '${DRIVE_FOLDER_MIME}' and name contains '${escapeDriveQuery(query.trim())}' and trashed = false`,
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  return foldersFromFiles(await driveJson(accessToken, { url, schema: FileList }, options));
}

/** The parents of a file, or none when this login cannot read it. */
async function readableParents(accessToken: string, fileId: string, options: DriveClientOptions): Promise<string[]> {
  try {
    return (await loadDriveFile(accessToken, fileId, options)).parents;
  } catch (error) {
    if (error instanceof DriveFolderError) {
      return [];
    }
    throw error;
  }
}

export async function fileInDriveFolder(
  accessToken: string,
  fileId: string,
  folderId: string,
  options: DriveClientOptions & { seen?: Set<string> } = {},
): Promise<boolean> {
  if (!fileId || !folderId) {
    return false;
  }
  if (fileId === folderId) {
    return true;
  }
  const seen = options.seen ?? new Set<string>();
  if (seen.has(fileId)) {
    return false;
  }
  seen.add(fileId);
  const parents = await readableParents(accessToken, fileId, options);
  if (parents.includes(folderId)) {
    return true;
  }
  for (const parent of parents.filter((id) => id !== DRIVE_MY_DRIVE)) {
    if (await fileInDriveFolder(accessToken, parent, folderId, { ...options, seen })) {
      return true;
    }
  }
  return false;
}

const DRIVE_LIST_FIELDS = "nextPageToken,files(id,name,mimeType,parents,webViewLink,modifiedTime)";
const DRIVE_SEARCH_STRUCTURED =
  /\b(contains|=|!=|<=|>=|<|>|and|or|not|parentId|title|name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|owner|sharedWithMe)\b/i;

export function translateDriveSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }
  if (!DRIVE_SEARCH_STRUCTURED.test(trimmed)) {
    const escaped = escapeDriveQuery(trimmed);
    return `(name contains '${escaped}' or fullText contains '${escaped}')`;
  }
  return trimmed
    .replace(/\btitle\b/g, "name")
    .replace(/parentId\s*=\s*'((?:\\'|[^'])*)'/gi, (_match, id: string) => `'${id}' in parents`)
    .replace(/\bowner\s*=\s*'((?:\\'|[^'])*)'/gi, (_match, id: string) => `'${id}' in owners`)
    .replace(/\bowner\s*!=\s*'((?:\\'|[^'])*)'/gi, (_match, id: string) => `not '${id}' in owners`);
}

function drivePageSize(args: Record<string, unknown>, fallback: number): number {
  const raw = args.pageSize ?? args.page_size;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(100, Math.floor(n));
}

function drivePageToken(args: Record<string, unknown>): string {
  const raw = args.pageToken ?? args.page_token;
  return typeof raw === "string" ? raw.trim() : "";
}

type DriveCorpus = { corpora: "user" } | { corpora: "drive"; driveId: string };

async function driveSearchCorpus(scoped: ScopedDrive): Promise<DriveCorpus> {
  const { accessToken, folderId } = scoped;
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,driveId&supportsAllDrives=true`;
  try {
    const driveId = (await driveJson(accessToken, { url, schema: DriveFile }, scoped)).driveId?.trim();
    return driveId ? { corpora: "drive", driveId } : { corpora: "user" };
  } catch (error) {
    if (!(error instanceof DriveFolderError)) {
      throw error;
    }
    try {
      const drive = await loadSharedDrive(accessToken, folderId, scoped);
      return { corpora: "drive", driveId: drive.id };
    } catch {
      throw error;
    }
  }
}

function setCorpus(params: URLSearchParams, corpus: DriveCorpus): void {
  if (corpus.corpora === "user") {
    params.set("corpora", "user");
    return;
  }
  params.set("corpora", "drive");
  params.set("driveId", corpus.driveId);
  params.set("includeItemsFromAllDrives", "true");
  params.set("supportsAllDrives", "true");
}

function mcpFileFromDrive(row: DriveFile): McpFile | null {
  if (!row.id) {
    return null;
  }
  return {
    id: row.id,
    title: row.name ?? "",
    parentId: (row.parents ?? []).find(Boolean) ?? "",
    mimeType: row.mimeType ?? "",
  };
}

/** Whether a listed file is the connected folder, directly in it, or below it. */
async function inScopedFolder(scoped: ScopedDrive, file: { id: string; parentId: string }): Promise<boolean> {
  if (file.id === scoped.folderId || file.parentId === scoped.folderId) {
    return true;
  }
  return fileInDriveFolder(scoped.accessToken, file.id, scoped.folderId, scoped);
}

async function keepDriveSearchHits(scoped: ScopedDrive, rows: DriveFile[]): Promise<McpFile[]> {
  const kept: McpFile[] = [];
  for (const row of rows) {
    const mapped = mcpFileFromDrive(row);
    if (mapped && (await inScopedFolder(scoped, mapped))) {
      kept.push(mapped);
    }
  }
  return kept;
}

async function listScopedDriveFiles(
  scoped: ScopedDrive,
  arguments_: Record<string, unknown>,
  extra: { q: string; orderBy?: string; pageSize: number },
): Promise<string> {
  const corpus = await driveSearchCorpus(scoped);
  const params = new URLSearchParams({
    q: extra.q,
    fields: DRIVE_LIST_FIELDS,
    pageSize: String(extra.pageSize),
  });
  if (extra.orderBy) {
    params.set("orderBy", extra.orderBy);
  }
  const pageToken = drivePageToken(arguments_);
  if (pageToken) {
    params.set("pageToken", pageToken);
  }
  setCorpus(params, corpus);
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const payload = await driveJson(scoped.accessToken, { url, schema: FileList }, scoped);
  const kept = await keepDriveSearchHits(scoped, payload.files ?? []);
  const nextPageToken = payload.nextPageToken ?? "";
  return JSON.stringify(nextPageToken ? { files: kept, nextPageToken } : { files: kept });
}

export async function searchDriveFolder(
  accessToken: string,
  folderId: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions = {},
): Promise<string> {
  const translated = translateDriveSearchQuery(typeof arguments_.query === "string" ? arguments_.query : "");
  return listScopedDriveFiles({ ...options, accessToken, folderId }, arguments_, {
    q: translated ? `${translated} and trashed = false` : "trashed = false",
    pageSize: drivePageSize(arguments_, 10),
  });
}

export async function listRecentDriveFiles(
  accessToken: string,
  folderId: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions = {},
): Promise<string> {
  const order = typeof arguments_.orderBy === "string" ? arguments_.orderBy : typeof arguments_.order_by === "string" ? arguments_.order_by : "";
  return listScopedDriveFiles({ ...options, accessToken, folderId }, arguments_, {
    q: "trashed = false",
    orderBy: order === "lastModifiedByMe" ? "modifiedByMeTime desc" : "modifiedTime desc",
    pageSize: drivePageSize(arguments_, 10),
  });
}

export function driveArg(args: Record<string, unknown>, camel: string, snake: string): string {
  const camelVal = args[camel];
  if (typeof camelVal === "string" && camelVal.trim()) {
    return camelVal.trim();
  }
  const snakeVal = args[snake];
  if (typeof snakeVal === "string" && snakeVal.trim()) {
    return snakeVal.trim();
  }
  return "";
}

function driveQueryParents(query: string): { neq: boolean; ids: string[] } {
  const ids: string[] = [];
  let neq = false;
  const pattern = /parentId\s*(=|!=)\s*'((?:\\'|[^'])*)'/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    if (match[1] === "!=") {
      neq = true;
    }
    const id = (match[2] ?? "").replace(/\\'/g, "'");
    if (id) {
      ids.push(id);
    }
  }
  return { neq, ids };
}

const OUTSIDE_FOLDER = "Drive tools are limited to the connected folder";

/** The tools that act on one file, and so need a file to act on. */
const FILE_TOOLS = new Set(["get_file_metadata", "get_file_permissions", "read_file_content", "download_file_content"]);

async function assertInFolder(scoped: ScopedDrive, fileId: string): Promise<void> {
  if (!(await fileInDriveFolder(scoped.accessToken, fileId, scoped.folderId, scoped))) {
    throw new DriveFolderError(OUTSIDE_FOLDER);
  }
}

/** A search may name parents inside the connected folder, and never exclude one. */
async function constrainSearch(scoped: ScopedDrive, arguments_: Record<string, unknown>): Promise<void> {
  const parents = driveQueryParents(typeof arguments_.query === "string" ? arguments_.query : "");
  if (parents.neq) {
    throw new DriveFolderError("Drive search cannot exclude the connected folder");
  }
  for (const id of parents.ids) {
    await assertInFolder(scoped, id);
  }
}

/** A create goes into the connected folder, or a folder inside it. */
async function constrainCreate(scoped: ScopedDrive, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parent = driveArg(arguments_, "parentId", "parent_id");
  if (!parent) {
    return { ...arguments_, parentId: scoped.folderId };
  }
  await assertInFolder(scoped, parent);
  return arguments_;
}

export async function constrainDriveTool(
  remoteName: string,
  arguments_: Record<string, unknown>,
  options: ScopedDrive,
): Promise<Record<string, unknown>> {
  if (remoteName === "search_files") {
    await constrainSearch(options, arguments_);
    return arguments_;
  }
  if (remoteName === "list_recent_files") {
    return arguments_;
  }
  if (remoteName === "create_file") {
    return constrainCreate(options, arguments_);
  }
  const fileId = driveArg(arguments_, "fileId", "file_id");
  if (remoteName === "copy_file" && !fileId) {
    throw new DriveFolderError("copy_file requires fileId");
  }
  if (fileId) {
    await assertInFolder(options, fileId);
  }
  const parent = driveArg(arguments_, "parentId", "parent_id");
  if (parent) {
    await assertInFolder(options, parent);
  }
  if (!fileId && !parent && FILE_TOOLS.has(remoteName)) {
    throw new DriveFolderError(`${remoteName} requires fileId`);
  }
  return arguments_;
}

function mcpContentText(result: JsonObject): string {
  const content = result.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Value.Check(UnknownList, content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (Value.Check(TextPart, item)) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function coerceFileRows(files: unknown): unknown[] | null {
  if (files == null) {
    return [];
  }
  if (Value.Check(UnknownList, files)) {
    return files;
  }
  if (typeof files === "object") {
    return [files];
  }
  return null;
}

type DriveFileListing = { payload: JsonObject; files: unknown[] };

function emptyListing(): DriveFileListing {
  return { payload: {}, files: [] };
}

/** The listing a remote tool result holds, or null when it holds none this filter can read. */
function driveFileListing(value: unknown): DriveFileListing | null {
  if (value == null) {
    return emptyListing();
  }
  if (typeof value === "string") {
    return listingFromText(value);
  }
  if (Value.Check(UnknownList, value)) {
    return { payload: {}, files: value };
  }
  return isJsonObject(value) ? listingFromObject(value) : null;
}

function listingFromText(value: string): DriveFileListing | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return emptyListing();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return driveFileListing(parsed);
}

/** A result object's listing: its structured content, its files, its text content, or a bare page token. */
function listingFromObject(rec: JsonObject): DriveFileListing | null {
  if (rec.structuredContent !== undefined) {
    const inner = driveFileListing(rec.structuredContent);
    if (inner) {
      return inner;
    }
  }
  if ("files" in rec) {
    const files = coerceFileRows(rec.files);
    return files ? { payload: rec, files } : null;
  }
  if (rec.content !== undefined) {
    const text = mcpContentText(rec);
    return text.trim() ? driveFileListing(text) : emptyListing();
  }
  const extra = Object.keys(rec).filter((key) => key !== "nextPageToken" && key !== "next_page_token");
  return extra.length === 0 ? { payload: rec, files: [] } : null;
}

/** A result with no listing in it: its text when that text is a message, not unreadable JSON. */
function unlistedResultText(result: unknown, rec: JsonObject | null): string {
  const text = typeof result === "string" ? result.trim() : rec ? mcpContentText(rec).trim() : "";
  if (text && text[0] !== "[" && text[0] !== "{") {
    return text;
  }
  throw new DriveFolderError("Drive folder filter could not read the result");
}

/** The listed files inside the connected folder, each as the remote tool returned it. */
async function keepListedFiles(scoped: ScopedDrive, files: unknown[]): Promise<unknown[]> {
  const kept: unknown[] = [];
  for (const item of files) {
    if (!Value.Check(ListedFile, item) || !item.id) {
      continue;
    }
    const parentId =
      typeof item.parentId === "string" ? item.parentId : typeof item.parent_id === "string" ? item.parent_id : "";
    if (await inScopedFolder(scoped, { id: item.id, parentId })) {
      kept.push(item);
    }
  }
  return kept;
}

function listingPageToken(payload: JsonObject): string {
  if (typeof payload.nextPageToken === "string") {
    return payload.nextPageToken;
  }
  return typeof payload.next_page_token === "string" ? payload.next_page_token : "";
}

export async function filterDriveToolResult(
  remoteName: string,
  result: unknown,
  options: ScopedDrive,
): Promise<string> {
  if (remoteName !== "search_files" && remoteName !== "list_recent_files") {
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  const rec = isJsonObject(result) ? result : null;
  const errorText = rec?.isError === true ? mcpContentText(rec).trim() : "";
  if (errorText) {
    return errorText;
  }
  const listing = driveFileListing(result);
  if (!listing) {
    return unlistedResultText(result, rec);
  }
  const kept = await keepListedFiles(options, listing.files);
  const nextPageToken = listingPageToken(listing.payload);
  return JSON.stringify(nextPageToken ? { files: kept, nextPageToken } : { files: kept });
}
