import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isJsonValue, isObjectNode, type JsonObject, type JsonValue } from "../../lib/json.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { decodeBody, type ConnectorApi } from "../response.js";
import {
  given,
  type CreateFileArguments,
  type FileReference,
  type ListRecentFilesArguments,
  type SearchFilesArguments,
} from "./parameters.js";
import {
  DriveFile,
  ErrorBody,
  FileList,
  ListedFile,
  ListingPage,
  ResultText,
  SharedDrive,
  TextPart,
  type GoogleError,
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

/** The client options with the access token of the login that makes the calls. */
export type DriveLogin = DriveClientOptions & { accessToken: string };

/** The client options of a call scoped to the connected folder, with the login that makes it. */
export type ScopedDrive = DriveLogin & { folderId: string };

export type DriveFolder = { id: string; name: string };

/** The method, headers and body of a Drive API request. */
export type DriveRequestInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

/** One Drive API request: its URL, the schema of its response, and its method and body. */
export type DriveRequest<T extends TSchema> = {
  url: string;
  schema: T;
  init?: DriveRequestInit;
};

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
};

/** A file as the Drive MCP tools return it: its id, title, first parent and type, empty when Drive has none. */
export type McpFile = { id: string; title: string; parentId: string; mimeType: string };

function driveFetch(options: DriveClientOptions): FetchFn {
  return options.client ?? proxyFetch(options.proxyUrl ?? "");
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

export function parseDriveFolderRef(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new DriveFolderError("Google Drive Connect requires picking one folder");
  }
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

/** Why a Google error happened: the first reason among `details`, else that of `errors[0]`, else `status`. */
function errorReason(error: GoogleError): string {
  const detailed = error.details?.find((entry) => entry.reason)?.reason;
  return detailed || error.errors?.[0]?.reason || error.status || "";
}

/** The Drive API as the connector reads its responses. */
const DRIVE: ConnectorApi<typeof ErrorBody> = {
  name: "Drive",
  error: (message) => new DriveFolderError(message),
  errorBody: ErrorBody,
  errorMessage: (body) => body.error.message ?? null,
};

/** The error body a failed response's `text` holds; null when it holds none, and so says nothing. */
function errorBodyOf(text: string): ErrorBody | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return Value.Check(ErrorBody, payload) ? payload : null;
}

/** What a failed response says to the operator: the fix its error calls for, else its message, else its status. */
function driveLookupError(status: number, text: string): string {
  if (status === 404) {
    return "picked folder is not available to this login";
  }
  const body = errorBodyOf(text) ?? { error: {} };
  const message = DRIVE.errorMessage(body) ?? "";
  const reason = errorReason(body.error);
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
  return decodeBody(DRIVE, request.schema, text);
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

/** Whether `fileId` is the scoped folder or below it, walking readable parents not already in `seen`. */
async function reachesFolder(scoped: ScopedDrive, fileId: string, seen: Set<string>): Promise<boolean> {
  if (fileId === scoped.folderId) {
    return true;
  }
  if (seen.has(fileId)) {
    return false;
  }
  seen.add(fileId);
  const parents = await readableParents(scoped.accessToken, fileId, scoped);
  if (parents.includes(scoped.folderId)) {
    return true;
  }
  for (const parent of parents.filter((id) => id !== DRIVE_MY_DRIVE)) {
    if (await reachesFolder(scoped, parent, seen)) {
      return true;
    }
  }
  return false;
}

export async function fileInDriveFolder(
  accessToken: string,
  fileId: string,
  folderId: string,
  options: DriveClientOptions = {},
): Promise<boolean> {
  if (!fileId || !folderId) {
    return false;
  }
  return reachesFolder({ ...options, accessToken, folderId }, fileId, new Set<string>());
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

/** The files a listing page holds when the call names no size. */
const DEFAULT_PAGE_SIZE = 10;

/** The files a listing page holds: the size the call names, at most 100, else the default. */
function drivePageSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size) || size < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(100, Math.floor(size));
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

/** A Drive file as the Drive MCP tools return it. */
export function mcpFile(row: DriveFile): McpFile {
  return {
    id: row.id ?? "",
    title: row.name ?? "",
    parentId: (row.parents ?? []).find(Boolean) ?? "",
    mimeType: row.mimeType ?? "",
  };
}

/** Whether a listed file is the connected folder, directly in it, or below it. */
async function inScopedFolder(scoped: ScopedDrive, file: Pick<McpFile, "id" | "parentId">): Promise<boolean> {
  if (file.id === scoped.folderId || file.parentId === scoped.folderId) {
    return true;
  }
  return fileInDriveFolder(scoped.accessToken, file.id, scoped.folderId, scoped);
}

async function keepDriveSearchHits(scoped: ScopedDrive, rows: DriveFile[]): Promise<McpFile[]> {
  const kept: McpFile[] = [];
  for (const row of rows) {
    const mapped = mcpFile(row);
    if (mapped.id && (await inScopedFolder(scoped, mapped))) {
      kept.push(mapped);
    }
  }
  return kept;
}

/** A Drive files listing: the `q` filter, its order, the page size, and the page to read; an empty token reads the first. */
type DriveListQuery = { q: string; orderBy?: string; pageSize: number; pageToken: string };

async function listScopedDriveFiles(scoped: ScopedDrive, query: DriveListQuery): Promise<string> {
  const corpus = await driveSearchCorpus(scoped);
  const params = new URLSearchParams({
    q: query.q,
    fields: DRIVE_LIST_FIELDS,
    pageSize: String(query.pageSize),
  });
  if (query.orderBy) {
    params.set("orderBy", query.orderBy);
  }
  if (query.pageToken) {
    params.set("pageToken", query.pageToken);
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
  arguments_: SearchFilesArguments,
  options: DriveClientOptions = {},
): Promise<string> {
  const translated = translateDriveSearchQuery(arguments_.query ?? "");
  return listScopedDriveFiles({ ...options, accessToken, folderId }, {
    q: translated ? `${translated} and trashed = false` : "trashed = false",
    pageSize: drivePageSize(arguments_.pageSize ?? arguments_.page_size),
    pageToken: given(arguments_.pageToken, arguments_.page_token),
  });
}

export async function listRecentDriveFiles(
  accessToken: string,
  folderId: string,
  arguments_: ListRecentFilesArguments,
  options: DriveClientOptions = {},
): Promise<string> {
  const order = arguments_.orderBy ?? arguments_.order_by ?? "";
  return listScopedDriveFiles({ ...options, accessToken, folderId }, {
    q: "trashed = false",
    orderBy: order === "lastModifiedByMe" ? "modifiedByMeTime desc" : "modifiedTime desc",
    pageSize: drivePageSize(arguments_.pageSize ?? arguments_.page_size),
    pageToken: given(arguments_.pageToken, arguments_.page_token),
  });
}

/** The parents a search query names: their ids, and whether it excludes any of them. */
type QueryParents = { neq: boolean; ids: string[] };

function driveQueryParents(query: string): QueryParents {
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

async function assertInFolder(scoped: ScopedDrive, fileId: string): Promise<void> {
  if (!(await fileInDriveFolder(scoped.accessToken, fileId, scoped.folderId, scoped))) {
    throw new DriveFolderError(OUTSIDE_FOLDER);
  }
}

/** A search may name parents inside the connected folder, and never exclude one. */
export async function constrainSearch(scoped: ScopedDrive, query: string): Promise<void> {
  const parents = driveQueryParents(query);
  if (parents.neq) {
    throw new DriveFolderError("Drive search cannot exclude the connected folder");
  }
  for (const id of parents.ids) {
    await assertInFolder(scoped, id);
  }
}

/** A create goes into the connected folder, or a folder inside it: a create that names no parent is given the connected folder. */
export async function constrainCreate(scoped: ScopedDrive, arguments_: CreateFileArguments): Promise<CreateFileArguments> {
  const parent = given(arguments_.parentId);
  if (!parent) {
    return { ...arguments_, parentId: scoped.folderId };
  }
  await assertInFolder(scoped, parent);
  return arguments_;
}

/** The file a call names, and the folder it names, are each inside the connected folder. */
export async function assertReachesFolder(scoped: ScopedDrive, reference: FileReference): Promise<void> {
  for (const id of [given(reference.fileId, reference.file_id), given(reference.parentId, reference.parent_id)]) {
    if (id) {
      await assertInFolder(scoped, id);
    }
  }
}

/** The text of a remote tool result's content: the content when it is text, else its text parts, one per line. */
function mcpContentText(result: JsonObject): string {
  const content = result.content;
  if (Value.Check(ResultText, content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (Value.Check(ResultText, item)) {
      parts.push(item);
    } else if (Value.Check(TextPart, item)) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

/** The rows of a listing's `files`: none when it is absent, the one row an object is, null when it is not rows. */
function coerceFileRows(files: JsonValue | undefined): JsonValue[] | null {
  if (files == null) {
    return [];
  }
  if (Array.isArray(files)) {
    return files;
  }
  return isObjectNode(files) ? [files] : null;
}

/** A remote listing: the object that carries its page token, and the files it names, each as the remote tool returned it. */
type DriveFileListing = { payload: JsonObject; files: JsonValue[] };

function emptyListing(): DriveFileListing {
  return { payload: {}, files: [] };
}

/** The listing a remote tool result holds, or null when it holds none this filter can read. */
function driveFileListing(value: JsonValue): DriveFileListing | null {
  if (value === null) {
    return emptyListing();
  }
  if (Value.Check(ResultText, value)) {
    return listingFromText(value);
  }
  if (Array.isArray(value)) {
    return { payload: {}, files: value };
  }
  return isObjectNode(value) ? listingFromObject(value) : null;
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
  return isJsonValue(parsed) ? driveFileListing(parsed) : null;
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
function unlistedResultText(result: JsonValue, rec: JsonObject | null): string {
  const text = Value.Check(ResultText, result) ? result.trim() : rec ? mcpContentText(rec).trim() : "";
  if (text && text[0] !== "[" && text[0] !== "{") {
    return text;
  }
  throw new DriveFolderError("Drive folder filter could not read the result");
}

/** The listed files inside the connected folder, each as the remote tool returned it. */
async function keepListedFiles(scoped: ScopedDrive, files: JsonValue[]): Promise<JsonValue[]> {
  const kept: JsonValue[] = [];
  for (const item of files) {
    if (!Value.Check(ListedFile, item) || !item.id) {
      continue;
    }
    if (await inScopedFolder(scoped, { id: item.id, parentId: item.parentId ?? item.parent_id ?? "" })) {
      kept.push(item);
    }
  }
  return kept;
}

function listingPageToken(payload: JsonObject): string {
  return Value.Check(ListingPage, payload) ? (payload.nextPageToken ?? payload.next_page_token ?? "") : "";
}

/**
 * A remote `search_files` or `list_recent_files` result, its text or the JSON it holds, with only
 * the files inside the connected folder; another tool's result as its text.
 */
export async function filterDriveToolResult(
  remoteName: string,
  result: JsonValue,
  options: ScopedDrive,
): Promise<string> {
  if (remoteName !== "search_files" && remoteName !== "list_recent_files") {
    return Value.Check(ResultText, result) ? result : JSON.stringify(result);
  }
  const rec = isObjectNode(result) ? result : null;
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
