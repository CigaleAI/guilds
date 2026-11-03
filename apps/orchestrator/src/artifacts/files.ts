import { createHash } from "node:crypto";
import path from "node:path";
import { formatOperationalTimestamp } from "../db/codecs.js";
import { isUniqueViolation, withTransaction } from "../db/pg.js";
import { newId } from "../lib/ids.js";
import { BlobMissing, type BlobStore } from "../lib/blob-store.js";
import { creatorGrant } from "./access.js";
import { ArtifactError } from "./errors.js";
import { recordFileChange } from "../db/file-changes.js";
import { FILES_SEGMENT, normalizeFileName, parseDisplayPath } from "./paths.js";
import { findLimit } from "./search.js";
import {
  artifactMode,
  assertLiveCount,
  assertRead,
  assertWrite,
  itemHome,
  pageSections,
  rowDisplayPath,
  type ArtifactStore,
  type ItemHome,
  type PageSections,
  type ViewerMode,
} from "./store.js";
import type { ArtifactRow } from "../db/artifacts.js";
import {
  FILE_DESCRIPTION_MAX,
  FILE_MAX_BYTES,
  ORG_FILE_BYTES_MAX,
  SEARCH_TEXT_MAX,
  type AccessGrant,
  type ArtifactActor,
} from "./types.js";
import type { AccessMode } from "../db/schema/index.js";
import { requireSubject, writeGrants } from "./grants.js";
import {
  getLiveArtifact,
  insertFile,
  isMissingHomeGuild,
  softDeleteArtifact,
  sumOrgFileBytes,
  updateFileContent,
} from "../db/artifacts.js";
import {
  listAgentPageArtifacts,
  listArtifactsByKind,
  listGuildPageArtifacts,
  listOrgArtifacts,
  searchArtifactsByKind,
  type AgentViewerMode,
  type GuildViewerMode,
  type PageArtifactRow,
} from "../db/artifact-lists.js";
import { agentReader, loadParsed, type ReachingAgent } from "./notes.js";

/** A file as the file tools, an upload, and a download return it. */
export type FileView = {
  id: string;
  display_path: string;
  name: string;
  description: string;
  mime: string;
  bytes: number;
  version: number;
  author: string;
  updated_at: string;
  access?: AccessMode;
};

/**
 * A file as an operator's page lists it: what the tools return but the reader's own mode, the guild
 * it is homed in (null for the organisation), and the mode of the page's viewer on it.
 */
export type PageFileView<Mode extends ViewerMode> = Omit<FileView, "access"> & {
  home: ItemHome | null;
  viewer_mode: Mode;
};

type FileContent = { description: string; mime: string; bytes: Buffer };

/**
 * A file as a writer sends it: its name, description, media type and bytes, the version it replaces
 * when the writer read one, and the rows its access list starts with when the put creates it;
 * without them, the creator's own row (`creatorGrant`).
 */
export type FileUpload = {
  name: string;
  description: string;
  mime: string;
  bytes: Buffer;
  expectedVersion?: number;
  startingAccess?: AccessGrant[];
};

/** A search of the files an actor reads: the words to match, and how many to return. */
export type FileSearch = { query?: string; limit: number };

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** The media type of each file name extension this store knows. */
const MIME_BY_EXTENSION = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
} satisfies Record<string, string>;

/** A file name extension whose media type this store knows. */
type KnownExtension = keyof typeof MIME_BY_EXTENSION;

function isKnownExtension(extension: string): extension is KnownExtension {
  return Object.hasOwn(MIME_BY_EXTENSION, extension);
}

/** The media type a file name's extension says, `application/octet-stream` for one it does not know. */
export function mimeForName(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return isKnownExtension(extension) ? MIME_BY_EXTENSION[extension] : "application/octet-stream";
}

/** A media type as sent by a client, or the one the name says when the client sent none. */
export function normalizeMime(raw: string, name: string): string {
  const mime = (raw || "").trim().split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) {
    return mimeForName(name);
  }
  if (!MIME_RE.test(mime) || mime.length > 127) {
    throw new ArtifactError("mime must be a media type such as application/pdf", 422);
  }
  return mime;
}

export function validateFileDescription(raw: string): string {
  const text = (raw || "").trim();
  if (!text) {
    throw new ArtifactError("description is required", 422);
  }
  if (text.length > FILE_DESCRIPTION_MAX) {
    throw new ArtifactError(`description must be at most ${FILE_DESCRIPTION_MAX} characters`, 422);
  }
  return text;
}

function assertFileBytes(bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new ArtifactError("file is empty", 422);
  }
  if (bytes.length > FILE_MAX_BYTES) {
    throw new ArtifactError(`file exceeds ${FILE_MAX_BYTES / (1024 * 1024)} MiB`, 422);
  }
}

/** Where a file's bytes sit in the blob store; each version has its own object. */
export function fileBlobKey(orgId: string, fileId: string, version: number): string {
  return `${orgId}/files/${fileId}/v${version}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function searchTextFor(name: string, description: string): string {
  return `${name} ${description}`.slice(0, SEARCH_TEXT_MAX);
}

/** The rows of `artifacts` with kind `file`: their bytes live in the blob store, one object per version. */
export class ArtifactFiles {
  constructor(
    private readonly store: ArtifactStore,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Stores the organisation's file of the upload's name. A live file of that name is replaced with
   * write access to it, and is otherwise refused as not writable; a missing one is created with the
   * upload's starting access list. An expected version of 0 asks for a new file, a 409 when one is
   * live; any other expected version must be the live file's, a 409 otherwise.
   */
  async putFile(
    actor: ArtifactActor,
    args: FileUpload,
  ): Promise<ArtifactRow> {
    const name = normalizeFileName(args.name);
    const content: FileContent = {
      description: validateFileDescription(args.description),
      mime: normalizeMime(args.mime, name),
      bytes: args.bytes,
    };
    assertFileBytes(content.bytes);
    const live = await loadParsed(this.store, {
      kind: "artifact",
      orgId: actor.orgId,
      agentId: null,
      path: FILES_SEGMENT,
      key: name,
    });
    if (live) {
      return this.replaceFile(actor, live, content, args.expectedVersion);
    }
    if (args.expectedVersion !== undefined && args.expectedVersion !== 0) {
      throw new ArtifactError("version conflict", 409);
    }
    return this.createFile(actor, name, content, args.startingAccess ?? [creatorGrant(actor)]);
  }

  /** The live file a display path names, with the actor's mode; 404 when it is not one the actor reaches. */
  async loadFile(actor: ArtifactActor, displayPath: string): Promise<ArtifactRow> {
    const parsed = parseDisplayPath(displayPath);
    if (parsed.kind !== "artifact" || parsed.orgId !== actor.orgId || parsed.path !== FILES_SEGMENT) {
      throw new ArtifactError("artifact not found", 404);
    }
    const row = await loadParsed(this.store, parsed);
    return this.reached(actor, row);
  }

  /** The live file with this id, with the actor's mode; 404 when it is not one the actor reaches. */
  async loadFileById(actor: ArtifactActor, fileId: string): Promise<ArtifactRow> {
    return this.reached(actor, await getLiveArtifact(this.store.db, actor.orgId, { id: fileId, kind: "file" }));
  }

  /** The bytes of a file row. */
  async readBytes(row: ArtifactRow): Promise<Buffer> {
    try {
      return await this.blobs.get(fileBlobKey(row.org_id, row.id, row.version));
    } catch (error) {
      if (error instanceof BlobMissing) {
        throw new ArtifactError("file bytes not found", 404);
      }
      throw error;
    }
  }

  /** The files the actor may read, searched by `query` over name and description, or listed. */
  async findFiles(
    actor: ArtifactActor,
    args: FileSearch,
  ): Promise<FileView[]> {
    const query = (args.query ?? "").trim();
    const limit = findLimit(args.limit);
    const rows = query
      ? await searchArtifactsByKind(this.store.db, actor, "file", { query, limit })
      : await listArtifactsByKind(this.store.db, actor, "file", limit);
    return rows.map((row) => this.view(row));
  }

  /** Every file of the organisation the actor may read, by name, with the organisation's viewer mode. */
  async listOrgFiles(actor: ArtifactActor): Promise<Array<PageFileView<GuildViewerMode>>> {
    return (await listOrgArtifacts(this.store.db, actor, "file")).map(pageFileView);
  }

  /**
   * The files a guild's page lists for the actor, by name, with the guild's viewer mode: in `own`
   * those homed in the guild, whatever their rows; in `shared` those homed elsewhere or in the
   * organisation whose access list has a row for the guild, one of its agents, or the organisation.
   */
  async listGuildFiles(actor: ArtifactActor, guildId: string): Promise<PageSections<PageFileView<GuildViewerMode>>> {
    return pageSections(await listGuildPageArtifacts(this.store.db, actor, guildId, "file"), pageFileView);
  }

  /** The files an agent's page lists for the actor: the sections of its guild's page, each file with the agent's viewer mode. */
  async listAgentFiles(actor: ArtifactActor, agent: ReachingAgent): Promise<PageSections<PageFileView<AgentViewerMode>>> {
    const reacher = agentReader(actor, agent);
    return pageSections(await listAgentPageArtifacts(this.store.db, actor, reacher, "file"), pageFileView);
  }

  /** Soft-deletes a file the actor writes, keeping its access list on the tombstone, and removes its bytes. */
  async deleteFile(actor: ArtifactActor, row: ArtifactRow): Promise<void> {
    await assertWrite(this.store, actor, row);
    await withTransaction(this.store.db, async (client) => {
      const now = new Date();
      const version = await softDeleteArtifact(client, row.id, actor, now);
      if (version === null) {
        throw new ArtifactError("artifact not found", 404);
      }
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: rowDisplayPath(row),
        operation: "delete",
        version,
        createdAt: now,
      });
    });
    await this.blobs.delete(fileBlobKey(row.org_id, row.id, row.version));
  }

  /** A file row as the file tools, an upload, and a download return it. */
  view(row: ArtifactRow): FileView {
    return {
      id: row.id,
      display_path: rowDisplayPath(row),
      name: row.key,
      description: row.title ?? "",
      mime: row.mime ?? "application/octet-stream",
      bytes: row.bytes ?? 0,
      version: row.version,
      author: row.updated_by_name,
      updated_at: formatOperationalTimestamp(row.updated_at),
      ...(row.access ? { access: row.access } : {}),
    };
  }

  private async reached(actor: ArtifactActor, row: ArtifactRow | null): Promise<ArtifactRow> {
    if (!row || row.kind !== "file") {
      throw new ArtifactError("artifact not found", 404);
    }
    const access = await assertRead(this.store, actor, row);
    return { ...row, access };
  }

  private async createFile(
    actor: ArtifactActor,
    name: string,
    content: FileContent,
    startingAccess: AccessGrant[],
  ): Promise<ArtifactRow> {
    await assertLiveCount(this.store, actor.orgId);
    for (const grant of startingAccess) {
      await requireSubject(this.store.db, actor, grant);
    }
    await this.assertOrgBytes(actor.orgId, content.bytes.length, null);
    const id = newId("art");
    const key = fileBlobKey(actor.orgId, id, 1);
    await this.blobs.put(key, content.bytes, content.mime);
    try {
      return await withTransaction(this.store.db, async (client) => {
        const row = await insertFile(
          client,
          {
            id,
            org_id: actor.orgId,
            origin_guild_id: actor.guildId,
            key: name,
            title: content.description,
            search_text: searchTextFor(name, content.description),
            mime: content.mime,
            bytes: content.bytes.length,
            content_hash: sha256(content.bytes),
          },
          actor,
          new Date(),
        );
        await writeGrants(client, actor, { kind: "file", id: row.id }, startingAccess);
        await recordFileChange(client, actor, {
          orgId: row.org_id,
          artifactId: row.id,
          displayPath: rowDisplayPath(row),
          operation: "create",
          version: row.version,
        });
        return { ...row, access: "write" as const };
      });
    } catch (error) {
      await this.blobs.delete(key);
      if (isUniqueViolation(error)) {
        throw new ArtifactError("artifact already exists", 409);
      }
      if (isMissingHomeGuild(error)) {
        throw new ArtifactError("unknown guild", 404);
      }
      throw error;
    }
  }

  private async replaceFile(
    actor: ArtifactActor,
    live: ArtifactRow,
    content: FileContent,
    expectedVersion: number | undefined,
  ): Promise<ArtifactRow> {
    if ((await artifactMode(this.store, actor, live)) !== "write") {
      throw new ArtifactError("write not allowed", 422);
    }
    if (expectedVersion === 0) {
      throw new ArtifactError("artifact already exists", 409);
    }
    if (expectedVersion !== undefined && live.version !== expectedVersion) {
      throw new ArtifactError("version conflict", 409);
    }
    await this.assertOrgBytes(live.org_id, content.bytes.length, live.id);
    const key = fileBlobKey(live.org_id, live.id, live.version + 1);
    await this.blobs.put(key, content.bytes, content.mime);
    let row: ArtifactRow;
    try {
      row = await withTransaction(this.store.db, async (client) => {
        const written = await updateFileContent(
          client,
          {
            id: live.id,
            title: content.description,
            search_text: searchTextFor(live.key, content.description),
            mime: content.mime,
            bytes: content.bytes.length,
            content_hash: sha256(content.bytes),
            version: live.version,
          },
          actor,
          new Date(),
        );
        if (!written) {
          throw new ArtifactError("version conflict", 409);
        }
        await recordFileChange(client, actor, {
          orgId: written.org_id,
          artifactId: written.id,
          displayPath: rowDisplayPath(written),
          operation: "update",
          version: written.version,
        });
        return written;
      });
    } catch (error) {
      await this.blobs.delete(key);
      throw error;
    }
    await this.blobs.delete(fileBlobKey(live.org_id, live.id, live.version));
    return { ...row, access: "write" as const };
  }

  /** A 422 when the organisation's live files would hold more than their cap with `adding` bytes. */
  private async assertOrgBytes(orgId: string, adding: number, replacingId: string | null): Promise<void> {
    if ((await sumOrgFileBytes(this.store.db, orgId, replacingId)) + adding > ORG_FILE_BYTES_MAX) {
      throw new ArtifactError("file storage limit reached", 422);
    }
  }
}

/** A file row as an operator's page lists it. */
function pageFileView<Mode extends ViewerMode>(row: PageArtifactRow<Mode>): PageFileView<Mode> {
  return {
    id: row.id,
    display_path: rowDisplayPath(row),
    name: row.key,
    description: row.title ?? "",
    mime: row.mime ?? "application/octet-stream",
    bytes: row.bytes ?? 0,
    version: row.version,
    author: row.updated_by_name,
    updated_at: formatOperationalTimestamp(row.updated_at),
    home: itemHome(row),
    viewer_mode: row.viewer_mode,
  };
}
