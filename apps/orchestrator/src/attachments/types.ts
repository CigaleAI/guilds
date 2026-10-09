export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const IMAGE_INPUT_TOKENS = 1600;
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

export const ATTACHMENT_KINDS = ["image", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type AttachmentRef = {
  id: string;
  filename: string;
  mime: string;
  kind: AttachmentKind;
};

export type AttachmentRow = AttachmentRef & {
  org_id: string;
  uploaded_by: string;
  bytes: number;
  sha256: string;
  created_at: string;
};

export class AttachmentError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.status = status;
  }
}

export type BlobStore = {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A short-lived HTTPS URL, or null when the store can only serve bytes. */
  signedReadUrl(key: string, ttlMs: number): Promise<string | null>;
};

export function objectKey(orgId: string, attachmentId: string): string {
  return `${orgId}/${attachmentId}`;
}
