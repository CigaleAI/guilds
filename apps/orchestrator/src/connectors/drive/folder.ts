import { proxyFetch, type FetchFn } from "../../net/http.js";

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

export type DriveFolder = { id: string; name: string };

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
};

function driveFetch(options: DriveClientOptions): FetchFn {
  return options.client ?? proxyFetch(options.proxyUrl ?? "");
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function parseDriveFolderRef(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new DriveFolderError("Google Drive Connect requires picking one folder");
  }
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname === "drive.google.com" || url.hostname.endsWith(".google.com")) {
      const folder = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (folder?.[1]) {
        return folder[1];
      }
      const id = url.searchParams.get("id");
      if (id?.trim()) {
        return id.trim();
      }
    }
  } catch {
    // Plain folder ids are not URLs.
  }
  const prefixed = trimmed.startsWith(DRIVE_ID_PREFIX) ? trimmed.slice(DRIVE_ID_PREFIX.length) : trimmed;
  if (/^[a-zA-Z0-9_-]+$/.test(prefixed)) {
    return prefixed;
  }
  throw new DriveFolderError("Google Drive Connect requires a Drive folder link or id");
}

function googleDriveError(text: string): { message: string; reason: string } {
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { message: "", reason: "" };
    }
    const err = (payload as { error?: unknown }).error;
    if (!err || typeof err !== "object" || Array.isArray(err)) {
      return { message: "", reason: "" };
    }
    const row = err as { message?: unknown; status?: unknown; errors?: unknown; details?: unknown };
    const message = typeof row.message === "string" ? row.message : "";
    let reason = typeof row.status === "string" ? row.status : "";
    if (Array.isArray(row.errors) && row.errors[0] && typeof row.errors[0] === "object") {
      const first = row.errors[0] as { reason?: unknown };
      if (typeof first.reason === "string" && first.reason) {
        reason = first.reason;
      }
    }
    if (Array.isArray(row.details)) {
      for (const item of row.details) {
        if (item && typeof item === "object" && typeof (item as { reason?: unknown }).reason === "string") {
          const detailReason = (item as { reason: string }).reason;
          if (detailReason) {
            reason = detailReason;
            break;
          }
        }
      }
    }
    return { message, reason };
  } catch {
    return { message: "", reason: "" };
  }
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

export async function driveJson(
  accessToken: string,
  url: string,
  options: DriveClientOptions,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  const response = await driveFetch(options)(url, {
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
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DriveFolderError("Drive folder lookup returned a non-object");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DriveFolderError("Drive folder lookup returned a non-object");
  }
  return payload as Record<string, unknown>;
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
  const payload = await driveJson(accessToken, url, options);
  if (typeof payload.id !== "string" || !payload.id) {
    throw new DriveFolderError("Drive folder lookup is missing id or name");
  }
  const parents = Array.isArray(payload.parents)
    ? payload.parents.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
  return {
    id: payload.id,
    name: typeof payload.name === "string" ? payload.name : "",
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "",
    parents,
  };
}

async function loadSharedDrive(
  accessToken: string,
  driveId: string,
  options: DriveClientOptions = {},
): Promise<DriveFolder> {
  const payload = await driveJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(driveId)}?fields=id,name`,
    options,
  );
  if (typeof payload.id !== "string" || !payload.id || typeof payload.name !== "string" || !payload.name.trim()) {
    throw new DriveFolderError("Drive folder lookup is missing id or name");
  }
  return { id: payload.id, name: payload.name.trim() };
}

function foldersFromFiles(payload: Record<string, unknown>): DriveFolder[] {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const folders: DriveFolder[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as { id?: unknown; name?: unknown };
    if (typeof row.id === "string" && row.id && typeof row.name === "string" && row.name.trim()) {
      folders.push({ id: row.id, name: row.name.trim() });
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
  const payload = await driveJson(accessToken, url, options);
  if (typeof payload.id !== "string" || !payload.id) {
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
  const payload = await driveJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    options,
  );
  return foldersFromFiles(payload);
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
  let meta: DriveFileMeta;
  try {
    meta = await loadDriveFile(accessToken, fileId, options);
  } catch (error) {
    if (error instanceof DriveFolderError) {
      return false;
    }
    throw error;
  }
  if (meta.parents.includes(folderId)) {
    return true;
  }
  for (const parent of meta.parents) {
    if (parent === DRIVE_MY_DRIVE) {
      continue;
    }
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

async function driveSearchCorpus(
  accessToken: string,
  folderId: string,
  options: DriveClientOptions,
): Promise<{ corpora: "user" } | { corpora: "drive"; driveId: string }> {
  try {
    const payload = await driveJson(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,driveId&supportsAllDrives=true`,
      options,
    );
    if (typeof payload.driveId === "string" && payload.driveId.trim()) {
      return { corpora: "drive", driveId: payload.driveId.trim() };
    }
    return { corpora: "user" };
  } catch (error) {
    if (!(error instanceof DriveFolderError)) {
      throw error;
    }
    try {
      const drive = await loadSharedDrive(accessToken, folderId, options);
      return { corpora: "drive", driveId: drive.id };
    } catch {
      throw error;
    }
  }
}

function mcpFileFromDrive(row: Record<string, unknown>): { id: string; title: string; parentId: string; mimeType: string } | null {
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) {
    return null;
  }
  const parents = Array.isArray(row.parents)
    ? row.parents.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
  return {
    id,
    title: typeof row.name === "string" ? row.name : "",
    parentId: parents[0] ?? "",
    mimeType: typeof row.mimeType === "string" ? row.mimeType : "",
  };
}

async function keepDriveSearchHits(
  accessToken: string,
  folderId: string,
  rows: unknown[],
  options: DriveClientOptions,
): Promise<Array<{ id: string; title: string; parentId: string; mimeType: string }>> {
  const kept: Array<{ id: string; title: string; parentId: string; mimeType: string }> = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const mapped = mcpFileFromDrive(item as Record<string, unknown>);
    if (!mapped) {
      continue;
    }
    if (
      mapped.id === folderId ||
      mapped.parentId === folderId ||
      (await fileInDriveFolder(accessToken, mapped.id, folderId, options))
    ) {
      kept.push(mapped);
    }
  }
  return kept;
}

async function listScopedDriveFiles(
  accessToken: string,
  folderId: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
  extra: { q: string; orderBy?: string; pageSize: number },
): Promise<string> {
  const corpus = await driveSearchCorpus(accessToken, folderId, options);
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
  if (corpus.corpora === "drive") {
    params.set("corpora", "drive");
    params.set("driveId", corpus.driveId);
    params.set("includeItemsFromAllDrives", "true");
    params.set("supportsAllDrives", "true");
  } else {
    params.set("corpora", "user");
  }
  const payload = await driveJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    options,
  );
  const kept = await keepDriveSearchHits(
    accessToken,
    folderId,
    Array.isArray(payload.files) ? payload.files : [],
    options,
  );
  const nextPageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
  return JSON.stringify(nextPageToken ? { files: kept, nextPageToken } : { files: kept });
}

export async function searchDriveFolder(
  accessToken: string,
  folderId: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions = {},
): Promise<string> {
  const translated = translateDriveSearchQuery(typeof arguments_.query === "string" ? arguments_.query : "");
  return listScopedDriveFiles(accessToken, folderId, arguments_, options, {
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
  return listScopedDriveFiles(accessToken, folderId, arguments_, options, {
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

async function assertInFolder(
  accessToken: string,
  fileId: string,
  folderId: string,
  options: DriveClientOptions,
  message: string,
): Promise<void> {
  if (!(await fileInDriveFolder(accessToken, fileId, folderId, options))) {
    throw new DriveFolderError(message);
  }
}

export async function constrainDriveTool(
  remoteName: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions & { accessToken: string; folderId: string },
): Promise<Record<string, unknown>> {
  const { accessToken, folderId } = options;
  const outside = "Drive tools are limited to the connected folder";
  if (remoteName === "search_files") {
    const query = typeof arguments_.query === "string" ? arguments_.query : "";
    const parents = driveQueryParents(query);
    if (parents.neq) {
      throw new DriveFolderError("Drive search cannot exclude the connected folder");
    }
    for (const id of parents.ids) {
      await assertInFolder(accessToken, id, folderId, options, outside);
    }
    return arguments_;
  }
  if (remoteName === "list_recent_files") {
    return arguments_;
  }
  if (remoteName === "create_file") {
    const parent = driveArg(arguments_, "parentId", "parent_id");
    if (!parent) {
      return { ...arguments_, parentId: folderId };
    }
    await assertInFolder(accessToken, parent, folderId, options, outside);
    return arguments_;
  }
  if (remoteName === "copy_file") {
    const fileId = driveArg(arguments_, "fileId", "file_id");
    if (!fileId) {
      throw new DriveFolderError("copy_file requires fileId");
    }
    await assertInFolder(accessToken, fileId, folderId, options, outside);
    const parent = driveArg(arguments_, "parentId", "parent_id");
    if (parent) {
      await assertInFolder(accessToken, parent, folderId, options, outside);
    }
    return arguments_;
  }
  const fileId = driveArg(arguments_, "fileId", "file_id");
  if (fileId) {
    await assertInFolder(accessToken, fileId, folderId, options, outside);
  }
  const parent = driveArg(arguments_, "parentId", "parent_id");
  if (parent) {
    await assertInFolder(accessToken, parent, folderId, options, outside);
  }
  if (
    !fileId &&
    !parent &&
    (remoteName === "get_file_metadata" ||
      remoteName === "get_file_permissions" ||
      remoteName === "read_file_content" ||
      remoteName === "download_file_content")
  ) {
    throw new DriveFolderError(`${remoteName} requires fileId`);
  }
  return arguments_;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function mcpContentText(result: Record<string, unknown>): string {
  const content = result.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function coerceFileRows(files: unknown): unknown[] | null {
  if (files == null) {
    return [];
  }
  if (Array.isArray(files)) {
    return files;
  }
  if (typeof files === "object") {
    return [files];
  }
  return null;
}

function driveFileListing(value: unknown): { payload: Record<string, unknown>; files: unknown[] } | null {
  if (value == null) {
    return { payload: {}, files: [] };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { payload: {}, files: [] };
    }
    try {
      return driveFileListing(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    return { payload: {}, files: value };
  }
  const rec = asRecord(value);
  if (!rec) {
    return null;
  }
  if (rec.structuredContent !== undefined) {
    const inner = driveFileListing(rec.structuredContent);
    if (inner) {
      return inner;
    }
  }
  if ("files" in rec) {
    const files = coerceFileRows(rec.files);
    if (files) {
      return { payload: rec, files };
    }
    return null;
  }
  if (rec.content !== undefined) {
    const text = mcpContentText(rec);
    if (!text.trim()) {
      return { payload: {}, files: [] };
    }
    return driveFileListing(text);
  }
  const extra = Object.keys(rec).filter((key) => key !== "nextPageToken" && key !== "next_page_token");
  if (extra.length === 0) {
    return { payload: rec, files: [] };
  }
  return null;
}

export async function filterDriveToolResult(
  remoteName: string,
  result: unknown,
  options: DriveClientOptions & { accessToken: string; folderId: string },
): Promise<string> {
  if (remoteName !== "search_files" && remoteName !== "list_recent_files") {
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  const rec = asRecord(result);
  if (rec?.isError === true) {
    const text = mcpContentText(rec).trim();
    if (text) {
      return text;
    }
  }
  const listing = driveFileListing(result);
  if (!listing) {
    const text =
      typeof result === "string"
        ? result.trim()
        : rec
          ? mcpContentText(rec).trim()
          : "";
    if (text && text[0] !== "[" && text[0] !== "{") {
      return text;
    }
    throw new DriveFolderError("Drive folder filter could not read the result");
  }
  const kept: unknown[] = [];
  for (const item of listing.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as { id?: unknown; parentId?: unknown; parent_id?: unknown };
    const id = typeof row.id === "string" ? row.id : "";
    const parentId =
      typeof row.parentId === "string" ? row.parentId : typeof row.parent_id === "string" ? row.parent_id : "";
    if (!id) {
      continue;
    }
    if (
      id === options.folderId ||
      parentId === options.folderId ||
      (await fileInDriveFolder(options.accessToken, id, options.folderId, options))
    ) {
      kept.push(item);
    }
  }
  const nextPageToken =
    typeof listing.payload.nextPageToken === "string"
      ? listing.payload.nextPageToken
      : typeof listing.payload.next_page_token === "string"
        ? listing.payload.next_page_token
        : "";
  return JSON.stringify(nextPageToken ? { files: kept, nextPageToken } : { files: kept });
}
