import { createHash } from "node:crypto";
import { modelAcceptsAttachments } from "../llm/catalog.js";
import { modelNeedsInlineImages } from "../llm/providers.js";
import { newId } from "../lib/ids.js";
import { iso } from "../db/views.js";
import { sanitizeFilename, sniffImage } from "./sniff.js";
import { hydrateMessages } from "./hydrate.js";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  objectKey,
  type AttachmentRef,
  type AttachmentRow,
  type BlobStore,
} from "./types.js";

export type AttachmentDatabase = {
  insertAttachment(row: {
    id: string;
    orgId: string;
    uploadedBy: string;
    filename: string;
    mime: string;
    bytes: number;
    sha256: string;
    kind: string;
    createdAt: Date;
  }): Promise<Record<string, unknown>>;
  getAttachment(id: string): Promise<Record<string, unknown> | null>;
  listAttachmentsByIds(orgId: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
};

function asRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    uploaded_by: String(row.uploaded_by),
    filename: String(row.filename),
    mime: String(row.mime),
    kind: row.kind === "file" ? "file" : "image",
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    created_at: iso(row.created_at),
  };
}

export class AttachmentService {
  constructor(
    private readonly db: AttachmentDatabase,
    readonly blobs: BlobStore,
  ) {}

  async projectMessages(
    orgId: string,
    rows: Array<{ payload?: unknown; metadata?: unknown }>,
    model = "",
  ): Promise<Array<Record<string, unknown>>> {
    return hydrateMessages(rows, this.blobs, orgId, {
      ...(modelNeedsInlineImages(model) ? { inlineImages: true } : {}),
    });
  }

  async upload(args: {
    orgId: string;
    userId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<AttachmentRow> {
    if (args.bytes.length === 0) {
      throw new AttachmentError(422, "file is empty");
    }
    if (args.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(422, "file is larger than 10 MiB");
    }
    const sniffed = sniffImage(args.bytes);
    const filename = sanitizeFilename(args.filename);
    const id = newId("att");
    const sha256 = createHash("sha256").update(args.bytes).digest("hex");
    await this.blobs.put(objectKey(args.orgId, id), args.bytes, sniffed.mime);
    const created = await this.db.insertAttachment({
      id,
      orgId: args.orgId,
      uploadedBy: args.userId,
      filename,
      mime: sniffed.mime,
      bytes: args.bytes.length,
      sha256,
      kind: sniffed.kind,
      createdAt: new Date(),
    });
    return asRow(created);
  }

  async getForOrg(orgId: string, id: string): Promise<{ row: AttachmentRow; bytes: Buffer }> {
    const raw = await this.db.getAttachment(id);
    if (raw === null || String(raw.org_id) !== orgId) {
      throw new AttachmentError(404, "attachment not found");
    }
    const row = asRow(raw);
    const bytes = await this.blobs.get(objectKey(orgId, id));
    return { row, bytes };
  }

  async resolveForMessage(args: {
    orgId: string;
    model: string;
    ids: string[];
  }): Promise<AttachmentRef[]> {
    if (!args.ids.length) {
      return [];
    }
    if (!modelAcceptsAttachments(args.model)) {
      throw new AttachmentError(422, "this agent's model does not accept attachments");
    }
    if (args.ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new AttachmentError(422, `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
    }
    const unique = [...new Set(args.ids)];
    if (unique.length !== args.ids.length) {
      throw new AttachmentError(422, "attachment_ids must not repeat");
    }
    const rows = await this.db.listAttachmentsByIds(args.orgId, unique);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const refs: AttachmentRef[] = [];
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) {
        throw new AttachmentError(404, "attachment not found");
      }
      refs.push({
        id: String(row.id),
        filename: String(row.filename),
        mime: String(row.mime),
        kind: row.kind === "file" ? "file" : "image",
      });
    }
    return refs;
  }
}

export function attachmentPayload(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    kind: row.kind,
    url: `/api/attachments/${row.id}`,
    created_at: row.created_at,
  };
}

/** The Content-Disposition header that shows the file in the browser. */
export function inlineDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "image";
  const encoded = encodeURIComponent(filename);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The Content-Disposition header that makes the browser save the file. */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "image";
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
