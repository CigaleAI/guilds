import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttachmentError,
  AttachmentService,
  IMAGE_INPUT_TOKENS,
  MAX_ATTACHMENT_BYTES,
  MemoryBlobStore,
  attachmentImageCount,
  countRunInputTokens,
  hydrateMessages,
  sanitizeFilename,
  sniffImage,
  type BlobStore,
} from "../../src/attachments/index.js";
import { countInputTokens } from "../../src/llm/index.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x0c, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.from("XXXX"),
]);

test("sniffImage accepts JPEG PNG GIF WebP and refuses SVG", () => {
  assert.equal(sniffImage(JPEG).mime, "image/jpeg");
  assert.equal(sniffImage(PNG).mime, "image/png");
  assert.equal(sniffImage(GIF).mime, "image/gif");
  assert.equal(sniffImage(WEBP).mime, "image/webp");
  assert.throws(
    () => sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")),
    (error: unknown) => error instanceof AttachmentError && error.status === 422,
  );
  assert.throws(
    () => sniffImage(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0xff)),
    (error: unknown) => error instanceof AttachmentError && /10 MiB/.test((error as Error).message),
  );
});

test("sanitizeFilename strips paths and control characters", () => {
  assert.equal(sanitizeFilename("  ../etc/passwd.png  "), "passwd.png");
  assert.equal(sanitizeFilename(""), "image");
  assert.equal(sanitizeFilename(".."), "image");
});

test("hydrateMessages turns stored refs into image_url parts without writing bytes into payload", async () => {
  const store = new MemoryBlobStore();
  await store.put("org_1/att_1", PNG, "image/png");
  const rows = [
    {
      payload: { role: "user", content: "look" },
      metadata: {
        attachments: [{ id: "att_1", filename: "shot.png", mime: "image/png", kind: "image" }],
      },
    },
  ];
  const [message] = await hydrateMessages(rows, store, "org_1");
  const content = message?.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[0]?.text, "look");
  assert.equal(content[1]?.type, "image_url");
  const url = (content[1]?.image_url as { url: string }).url;
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(JSON.stringify(rows[0]?.payload), JSON.stringify({ role: "user", content: "look" }));
});

test("hydrateMessages inlines images when the provider refuses public URLs", async () => {
  const store: BlobStore = {
    async put() {},
    async get() {
      return PNG;
    },
    async delete() {},
    async signedReadUrl() {
      return "https://signed.example/shot.png";
    },
  };
  const rows = [
    {
      payload: { role: "user", content: "look" },
      metadata: {
        attachments: [{ id: "att_1", filename: "shot.png", mime: "image/png", kind: "image" }],
      },
    },
  ];
  const [signed] = await hydrateMessages(rows, store, "org_1");
  const signedUrl = ((signed?.content as Array<Record<string, unknown>>)[1]?.image_url as { url: string })
    .url;
  assert.equal(signedUrl, "https://signed.example/shot.png");
  const [inline] = await hydrateMessages(rows, store, "org_1", { inlineImages: true });
  const inlineUrl = ((inline?.content as Array<Record<string, unknown>>)[1]?.image_url as { url: string })
    .url;
  assert.match(inlineUrl, /^data:image\/png;base64,/);
});

test("countRunInputTokens adds a flat image cost and does not encode a data URL", () => {
  const rows = [
    {
      payload: { role: "user", content: "look" },
      metadata: {
        attachments: [{ id: "att_1", filename: "shot.png", mime: "image/png", kind: "image" }],
      },
    },
  ];
  const textOnly = countInputTokens("deepinfra/zai-org/GLM-5.3-Flash", [
    { role: "user", content: "look" },
  ]);
  const counted = countRunInputTokens(
    "deepinfra/zai-org/GLM-5.3-Flash",
    rows,
    null,
    countInputTokens,
  );
  assert.equal(counted, textOnly + IMAGE_INPUT_TOKENS);
  assert.equal(attachmentImageCount(rows), 1);
});

test("AttachmentService uploads and resolves only for models that accept images", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    async insertAttachment(row: {
      id: string;
      orgId: string;
      uploadedBy: string;
      filename: string;
      mime: string;
      bytes: number;
      sha256: string;
      kind: string;
      createdAt: Date;
    }) {
      const stored = {
        id: row.id,
        org_id: row.orgId,
        uploaded_by: row.uploadedBy,
        filename: row.filename,
        mime: row.mime,
        bytes: row.bytes,
        sha256: row.sha256,
        kind: row.kind,
        created_at: row.createdAt.toISOString(),
      };
      rows.set(row.id, stored);
      return stored;
    },
    async getAttachment(id: string) {
      return rows.get(id) ?? null;
    },
    async listAttachmentsByIds(orgId: string, ids: string[]) {
      return ids
        .map((id) => rows.get(id))
        .filter((row): row is Record<string, unknown> => Boolean(row && row.org_id === orgId));
    },
  };
  const service = new AttachmentService(db, new MemoryBlobStore());
  const uploaded = await service.upload({
    orgId: "org_1",
    userId: "user_1",
    filename: "shot.png",
    bytes: PNG,
  });
  assert.equal(uploaded.mime, "image/png");
  const refs = await service.resolveForMessage({
    orgId: "org_1",
    model: "deepinfra/zai-org/GLM-5.3-Flash",
    ids: [uploaded.id],
  });
  assert.deepEqual(refs, [
    { id: uploaded.id, filename: "shot.png", mime: "image/png", kind: "image" },
  ]);
  await assert.rejects(
    () =>
      service.resolveForMessage({
        orgId: "org_1",
        model: "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
        ids: [uploaded.id],
      }),
    (error: unknown) =>
      error instanceof AttachmentError && /does not accept attachments/.test(error.message),
  );
});
