import type { InferSelectModel } from "drizzle-orm";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import { attachments } from "./schema/index.js";

export type AttachmentRow = InferSelectModel<typeof attachments>;

export type NewAttachment = {
  id: string;
  orgId: string;
  uploadedBy: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  kind: string;
};

const ATTACHMENT_COLUMNS = tableColumns(attachments);

export async function insertAttachment(
  pool: Queryable,
  attachment: NewAttachment,
  now: Date,
): Promise<AttachmentRow> {
  const result = await pool.query<AttachmentRow>(
    `INSERT INTO attachments (
       id, org_id, uploaded_by, filename, mime, bytes, sha256, kind, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ATTACHMENT_COLUMNS}`,
    [
      attachment.id,
      attachment.orgId,
      attachment.uploadedBy,
      attachment.filename,
      attachment.mime,
      attachment.bytes,
      attachment.sha256,
      attachment.kind,
      stamp(now),
    ],
  );
  const created = result.rows[0] ?? null;
  if (!created) {
    throw new RowMissing("attachment insert failed");
  }
  return created;
}

export async function getAttachment(pool: Queryable, id: string): Promise<AttachmentRow | null> {
  const result = await pool.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM attachments WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listAttachmentsByIds(
  pool: Queryable,
  orgId: string,
  ids: string[],
): Promise<AttachmentRow[]> {
  if (!ids.length) {
    return [];
  }
  const result = await pool.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM attachments WHERE org_id = $1 AND id = ANY($2::text[])`,
    [orgId, ids],
  );
  return result.rows;
}
