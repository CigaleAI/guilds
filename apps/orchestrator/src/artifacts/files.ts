import { createHash } from "node:crypto";
import path from "node:path";
import { formatOperationalTimestamp } from "../db/codecs.js";
import { isUniqueViolation, stamp, withTransaction } from "../db/pg.js";
import { newId } from "../lib/ids.js";
import { BlobMissing, type BlobStore } from "../lib/blob-store.js";
import { createsWritable, defaultGrants } from "./access.js";
import { ArtifactError } from "./errors.js";
import { recordFileChange } from "./file-changes.js";
import { displayPathFor, FILES_SEGMENT, normalizeFileName, parseDisplayPath } from "./paths.js";
import {
  ARTIFACT_RETURNING,
  ARTIFACT_SELECT,
  ArtifactStore,
  mapRow,
  rowAsDisplay,
  type ArtifactRow,
} from "./store.js";
import {
  FILE_DESCRIPTION_MAX,
  FILE_MAX_BYTES,
  ORG_FILE_BYTES_MAX,
  SEARCH_TEXT_MAX,
  type AccessMode,
  type ArtifactActor,
  type ArtifactLevel,
} from "./types.js";

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
    const owner = this.store.ownerFor(actor, args.level);
    const live = await this.store.loadParsed({
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
    const row = await this.store.loadParsed(parsed);
    return this.reached(actor, row);
  }

  /** The live file with this id, with the actor's mode; 404 when it is not one the actor reaches. */
  async loadFileById(actor: ArtifactActor, fileId: string): Promise<ArtifactRow> {
    const result = await this.store.db.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.id = $1 AND a.org_id = $2 AND a.kind = 'file' AND a.deleted_at IS NULL`,
      [fileId, actor.orgId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return this.reached(actor, row ? mapRow(row) : null);
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
      ? await this.store.searchByKind(actor, "file", { query, level: args.level, limit: args.limit })
      : await this.store.listByKind(actor, "file", { level: args.level, limit: args.limit });
    return rows.map((row) => this.view(row));
  }

  /** The files one owner holds that the actor may read, by name. */
  async listOwnerFiles(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): Promise<FileView[]> {
    const values: unknown[] = [actor.orgId, level, ownerId];
    const result = await this.store.db.query(
      `SELECT ${ARTIFACT_SELECT}
         FROM artifacts a
         LEFT JOIN artifact_collections c ON c.id = a.collection_id
        WHERE a.org_id = $1 AND a.level = $2 AND a.owner_id = $3 AND a.deleted_at IS NULL
          AND a.kind = 'file' AND (${this.store.readScope(actor, values)})
        ORDER BY a.key`,
      values,
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => this.view(mapRow(row)));
  }

  /** Soft-deletes a file the actor writes, drops its access list, and removes its bytes. */
  async deleteFile(actor: ArtifactActor, row: ArtifactRow): Promise<void> {
    await this.store.assertWrite(actor, row);
    await withTransaction(this.store.db, async (client) => {
      const now = new Date();
      const result = await client.query(
        `UPDATE artifacts
            SET deleted_at = $2, updated_by_type = $3, updated_by_id = $4, updated_by_name = $5, updated_at = $2
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING version`,
        [row.id, stamp(now), actor.actorType, actor.actorId, actor.actorName],
      );
      if (!result.rows[0]) {
        throw new ArtifactError("artifact not found", 404);
      }
      await client.query(`DELETE FROM artifact_access WHERE target_kind = 'file' AND target_id = $1`, [row.id]);
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: displayPathFor(rowAsDisplay(row)),
        operation: "delete",
        version: Number(result.rows[0].version),
        createdAt: now,
      });
    });
    await this.blobs.delete(fileBlobKey(row.org_id, row.id, row.version));
  }

  view(row: ArtifactRow): FileView {
    return {
      id: row.id,
      display_path: displayPathFor(rowAsDisplay(row)),
      name: row.key,
      description: row.title ?? "",
      mime: row.mime ?? "application/octet-stream",
      bytes: row.bytes ?? 0,
      level: row.level,
      owner_id: row.owner_id,
      version: row.version,
      author: row.updated_by_name,
      updated_at: formatOperationalTimestamp(String(row.updated_at)),
      ...(row.access ? { access: row.access } : {}),
    };
  }

  private async reached(actor: ArtifactActor, row: ArtifactRow | null): Promise<ArtifactRow> {
    if (!row || row.kind !== "file") {
      throw new ArtifactError("artifact not found", 404);
    }
    const access = await this.store.assertRead(actor, row);
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
    await this.store.assertLiveCount(target.owner.orgId, target.level, target.owner.ownerId);
    await this.assertOrgBytes(target.owner.orgId, content.bytes.length, null);
    const id = newId("art");
    const key = fileBlobKey(target.owner.orgId, id, 1);
    await this.blobs.put(key, content.bytes, content.mime);
    try {
      return await withTransaction(this.store.db, async (client) => {
        const result = await client.query(
          `INSERT INTO artifacts (
             id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
             collection_id, path, key, title, content_text, content_json, search_text, mime, bytes,
             content_hash, version,
             created_by_type, created_by_id, created_by_name,
             updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'file',NULL,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,1,
             $15,$16,$17,$15,$16,$17,$18,$18
           )
           RETURNING ${ARTIFACT_RETURNING}`,
          [
            id,
            target.owner.orgId,
            target.level,
            target.owner.ownerId,
            target.owner.guildId,
            target.owner.agentId,
            actor.guildId,
            FILES_SEGMENT,
            target.name,
            content.description,
            searchTextFor(target.name, content.description),
            content.mime,
            content.bytes.length,
            sha256(content.bytes),
            actor.actorType,
            actor.actorId,
            actor.actorName,
            stamp(new Date()),
          ],
        );
        const row = mapRow(result.rows[0] as Record<string, unknown>);
        await this.store.writeGrants(client, actor, { kind: "file", id: row.id }, defaultGrants(row.level, row.owner_id));
        await recordFileChange(client, actor, {
          orgId: row.org_id,
          artifactId: row.id,
          displayPath: displayPathFor(rowAsDisplay(row)),
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
    if ((await this.store.artifactMode(actor, live)) !== "write") {
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
        const result = await client.query(
          `UPDATE artifacts
              SET title = $2, search_text = $3, mime = $4, bytes = $5, content_hash = $6, version = version + 1,
                  updated_by_type = $7, updated_by_id = $8, updated_by_name = $9, updated_at = $10
            WHERE id = $1 AND deleted_at IS NULL AND version = $11
            RETURNING ${ARTIFACT_RETURNING}`,
          [
            live.id,
            content.description,
            searchTextFor(live.key, content.description),
            content.mime,
            content.bytes.length,
            sha256(content.bytes),
            actor.actorType,
            actor.actorId,
            actor.actorName,
            stamp(new Date()),
            live.version,
          ],
        );
        if (!result.rows[0]) {
          throw new ArtifactError("version conflict", 409);
        }
        const written = mapRow(result.rows[0] as Record<string, unknown>);
        await recordFileChange(client, actor, {
          orgId: written.org_id,
          artifactId: written.id,
          displayPath: displayPathFor(rowAsDisplay(written)),
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
    const result = await this.store.db.query(
      `SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM artifacts
        WHERE org_id = $1 AND kind = 'file' AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
      [orgId, replacingId],
    );
    if (Number((result.rows[0] as { n: string | number }).n) + adding > ORG_FILE_BYTES_MAX) {
      throw new ArtifactError("file storage limit reached", 422);
    }
  }
}
