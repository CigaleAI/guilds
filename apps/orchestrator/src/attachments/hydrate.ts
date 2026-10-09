import { jsonObj } from "../db/json.js";
import {
  IMAGE_INPUT_TOKENS,
  SIGNED_URL_TTL_MS,
  objectKey,
  type AttachmentRef,
  type BlobStore,
} from "./types.js";
import { isAttachmentKind } from "./sniff.js";

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonObj(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function attachmentsOf(metadata: unknown): AttachmentRef[] {
  const meta = asRecord(metadata);
  const raw = meta.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AttachmentRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const filename = typeof row.filename === "string" ? row.filename : "";
    const mime = typeof row.mime === "string" ? row.mime : "";
    const kind = typeof row.kind === "string" && isAttachmentKind(row.kind) ? row.kind : null;
    if (!id || !filename || !mime || !kind) {
      continue;
    }
    out.push({ id, filename, mime, kind });
  }
  return out;
}

export function attachmentImageCount(rows: Array<{ metadata?: unknown }>): number {
  let count = 0;
  for (const row of rows) {
    for (const item of attachmentsOf(row.metadata)) {
      if (item.kind === "image") {
        count += 1;
      }
    }
  }
  return count;
}

export function countRunInputTokens(
  model: string,
  rows: Array<{ payload?: unknown; metadata?: unknown }>,
  tools: unknown[] | null,
  countInputTokens: (model: string, messages: unknown[], tools?: unknown[] | null) => number,
): number {
  const payloads = rows.map((row) => {
    const payload = jsonObj(row.payload);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : { role: "user", content: "" };
  });
  return countInputTokens(model, payloads, tools) + attachmentImageCount(rows) * IMAGE_INPUT_TOKENS;
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function hydrateMessages(
  rows: Array<{ payload?: unknown; metadata?: unknown; org_id?: unknown }>,
  store: BlobStore,
  orgId: string,
  options: { inlineImages?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const payload = { ...asRecord(row.payload) };
    const refs = attachmentsOf(row.metadata).filter((item) => item.kind === "image");
    if (!refs.length) {
      messages.push(payload);
      continue;
    }
    const text = typeof payload.content === "string" ? payload.content : "";
    const parts: Array<Record<string, unknown>> = [];
    if (text) {
      parts.push({ type: "text", text });
    }
    for (const ref of refs) {
      const key = objectKey(orgId, ref.id);
      const url = options.inlineImages ? null : await store.signedReadUrl(key, SIGNED_URL_TTL_MS);
      const imageUrl = url ?? dataUrl(ref.mime, await store.get(key));
      parts.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    if (!parts.length) {
      parts.push({ type: "text", text: refs.map((item) => `[image: ${item.filename}]`).join(" ") });
    }
    payload.content = parts;
    messages.push(payload);
  }
  return messages;
}
