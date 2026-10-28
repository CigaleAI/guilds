import { AttachmentError, MAX_ATTACHMENT_BYTES } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87 = Buffer.from("GIF87a");
const GIF89 = Buffer.from("GIF89a");
const RIFF = Buffer.from("RIFF");
const WEBP = Buffer.from("WEBP");

export type SniffedImage = {
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  kind: "image";
};

export function sniffImage(bytes: Buffer): SniffedImage {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(422, "file is larger than 10 MiB");
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", kind: "image" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) {
    return { mime: "image/png", kind: "image" };
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).equals(GIF87) || bytes.subarray(0, 6).equals(GIF89))
  ) {
    return { mime: "image/gif", kind: "image" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF) &&
    bytes.subarray(8, 12).equals(WEBP)
  ) {
    return { mime: "image/webp", kind: "image" };
  }
  throw new AttachmentError(422, "file must be a JPEG, PNG, GIF, or WebP image");
}

export function sanitizeFilename(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed.split(/[/\\]/).pop() ?? "";
  const stripped = Array.from(base, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? "" : ch;
  }).join("");
  const cleaned = stripped.replace(/^\.+/, "");
  const name = cleaned.slice(0, 200).trim();
  return name || "image";
}
