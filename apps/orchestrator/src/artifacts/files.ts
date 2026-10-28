import { createHash } from "node:crypto";
import path from "node:path";
import { formatOperationalTimestamp } from "../db/codecs.js";
import { isUniqueViolation, withTransaction } from "../db/pg.js";
import { newId } from "../lib/ids.js";
import { BlobMissing, type BlobStore } from "../lib/blob-store.js";
import { createsWritable, defaultGrants } from "./access.js";
import { ArtifactError } from "./errors.js";
import { recordFileChange } from "../db/file-changes.js";
import { FILES_SEGMENT, normalizeFileName, parseDisplayPath } from "./paths.js";
import { artifactMode, assertLiveCount, assertRead, assertWrite, ownerFor, type ArtifactStore, rowDisplayPath } from "./store.js";
import type { ArtifactRow } from "../db/artifacts.js";
import {
  FILE_DESCRIPTION_MAX,
  FILE_MAX_BYTES,
  ORG_FILE_BYTES_MAX,
  SEARCH_TEXT_MAX,
  type ArtifactActor,
  type ArtifactLevel,
} from "./types.js";
import type { AccessMode } from "../db/schema/index.js";
import { writeGrants } from "./grants.js";
import { deleteAccessList } from "../db/artifact-access.js";
import {
  getLiveArtifact,
  insertFile,
  listArtifactsByKind,
  listOwnerArtifacts,
  searchArtifactsByKind,
  softDeleteArtifact,
  sumOrgFileBytes,
  updateFileContent,
} from "../db/artifacts.js";
import { loadParsed } from "./notes.js";

/** A file as tools and the API return it. */
export type FileView = {
  id: string;
  display_path: string;
  name: string;
  description: string;
  mime: string;
  bytes: number;
  level: ArtifactLevel;
  owner_id: string;
  version: number;
  author: string;
  updated_at: string;
  access?: AccessMode;
};

type Owner = { orgId: string; ownerId: string; guildId: string | null; agentId: string | null };

type FileContent = { description: string; mime: string; bytes: Buffer };

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
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
};

/** The media type a file name's extension says, `application/octet-stream` for one it does not know. */
export function mimeForName(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? "application/octet-stream";
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
   * Stores a file under one owner. An existing file of the same name is replaced with write
   * access to it; a new one is created where the level's starting access lets the writer write it.
   */
  async putFile(
    actor: ArtifactActor,
    args: { level: ArtifactLevel; name: string; description: string; mime: string; bytes: Buffer; expectedVersion?: number },
  ): Promise<ArtifactRow> {
    const name = normalizeFileName(args.name);
    const content: FileContent = {
      description: validateFileDescription(args.description),
      mime: normalizeMime(args.mime, name),
      bytes: args.bytes,
    };
    assertFileBytes(content.bytes);
    const owner = ownerFor(actor, args.level);
    const live = await loadParsed(this.store, {
      kind: "artifact",
      orgId: owner.orgId,
      level: args.level,
      ownerId: owner.ownerId,
      path: FILES_SEGMENT,
      key: name,
    });
    if (live) {
      return this.replaceFile(actor, live, content, args.expectedVersion);
    }
    return this.createFile(actor, { level: args.level, owner, name }, content);
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
    args: { query?: string; level?: ArtifactLevel; limit: number },
  ): Promise<FileView[]> {
    const query = (args.query ?? "").trim();
    const rows = query
      ? await searchArtifactsByKind(this.store.db, actor, "file", { query, level: args.level, limit: args.limit })
      : await listArtifactsByKind(this.store.db, actor, "file", { level: args.level, limit: args.limit });
    return rows.map((row) => this.view(row));
  }

  /** The files one owner holds that the actor may read, by name. */
  async listOwnerFiles(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): Promise<FileView[]> {
    const rows = await listOwnerArtifacts(this.store.db, actor, { level, owner_id: ownerId, kind: "file" });
    return rows.map((row) => this.view(row));
  }

  /** Soft-deletes a file the actor writes, drops its access list, and removes its bytes. */
  async deleteFile(actor: ArtifactActor, row: ArtifactRow): Promise<void> {
    await assertWrite(this.store, actor, row);
    await withTransaction(this.store.db, async (client) => {
      const now = new Date();
      const version = await softDeleteArtifact(client, row.id, actor, now);
      if (version === null) {
        throw new ArtifactError("artifact not found", 404);
      }
      await deleteAccessList(client, { kind: "file", id: row.id });
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

  view(row: ArtifactRow): FileView {
    return {
      id: row.id,
      display_path: rowDisplayPath(row),
      name: row.key,
      description: row.title ?? "",
      mime: row.mime ?? "application/octet-stream",
      bytes: row.bytes ?? 0,
      level: row.level,
      owner_id: row.owner_id,
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
    target: { level: ArtifactLevel; owner: Owner; name: string },
    content: FileContent,
  ): Promise<ArtifactRow> {
    if (!actor.operator && !createsWritable(target.level)) {
      throw new ArtifactError("write not allowed", 422);
    }
    await assertLiveCount(this.store, target.owner.orgId, target.level, target.owner.ownerId);
    await this.assertOrgBytes(target.owner.orgId, content.bytes.length, null);
    const id = newId("art");
    const key = fileBlobKey(target.owner.orgId, id, 1);
    await this.blobs.put(key, content.bytes, content.mime);
    try {
      return await withTransaction(this.store.db, async (client) => {
        const row = await insertFile(
          client,
          {
            id,
            org_id: target.owner.orgId,
            level: target.level,
            owner_id: target.owner.ownerId,
            guild_id: target.owner.guildId,
            agent_id: target.owner.agentId,
            origin_guild_id: actor.guildId,
            path: FILES_SEGMENT,
            key: target.name,
            title: content.description,
            search_text: searchTextFor(target.name, content.description),
            mime: content.mime,
            bytes: content.bytes.length,
            content_hash: sha256(content.bytes),
          },
          actor,
          new Date(),
        );
        await writeGrants(client, actor, { kind: "file", id: row.id }, defaultGrants(row.level, row.owner_id));
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
