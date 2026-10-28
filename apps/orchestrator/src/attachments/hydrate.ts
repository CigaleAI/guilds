import {
  IMAGE_INPUT_TOKENS,
  SIGNED_URL_TTL_MS,
  objectKey,
} from "./types.js";
import type { AttachmentRef, MessageMetadata, MessagePayload } from "../db/schema/index.js";
import type { BlobStore } from "../lib/blob-store.js";

/** A stored message as the attachments read it: what the model reads, and the files attached to it. */
export type AttachedMessage = { payload: MessagePayload; metadata: Pick<MessageMetadata, "attachments"> };

export function attachmentsOf(metadata: Pick<MessageMetadata, "attachments">): AttachmentRef[] {
  return metadata.attachments ?? [];
}

export function attachmentImageCount(rows: Array<Pick<AttachedMessage, "metadata">>): number {
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
  rows: AttachedMessage[],
  tools: unknown[] | null,
  countInputTokens: (model: string, messages: unknown[], tools?: unknown[] | null) => number,
): number {
  const payloads = rows.map((row) => row.payload);
  return countInputTokens(model, payloads, tools) + attachmentImageCount(rows) * IMAGE_INPUT_TOKENS;
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function hydrateMessages(
  rows: AttachedMessage[],
  store: BlobStore,
  orgId: string,
  options: { inlineImages?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const payload = row.payload;
    const refs = attachmentsOf(row.metadata).filter((item) => item.kind === "image");
    if (!refs.length) {
      messages.push(payload);
      continue;
    }
    const text = payload.content;
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
    messages.push({ ...payload, content: parts });
  }
  return messages;
}
