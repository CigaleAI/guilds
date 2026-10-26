import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** A key names no object: it is missing, or it could never name one. */
export class BlobMissing extends Error {
  constructor(message = "blob not found") {
    super(message);
    this.name = "BlobMissing";
  }
}

/** Bytes by key, shared by chat attachments and shared files. */
export type BlobStore = {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A short-lived HTTPS URL, or null when the store can only serve bytes. */
  signedReadUrl(key: string, ttlMs: number): Promise<string | null>;
};

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async get(key: string): Promise<Buffer> {
    const row = this.objects.get(key);
    if (!row) {
      throw new BlobMissing();
    }
    return Buffer.from(row.bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async signedReadUrl(_key: string, _ttlMs: number): Promise<string | null> {
    return null;
  }
}

/**
 * Objects as files under one directory, a key's `/` a subdirectory. The store serves bytes only;
 * it signs no URL.
 */
export class FileBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The file a key names; a key that would leave the root names nothing. */
  private fileFor(key: string): string {
    const unsafe = (segment: string) =>
      !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0");
    const segments = key.split("/");
    if (segments.some(unsafe)) {
      throw new BlobMissing();
    }
    const file = path.join(this.root, ...segments);
    if (!file.startsWith(this.root + path.sep)) {
      throw new BlobMissing();
    }
    return file;
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Written beside the target and renamed, so a reader never sees half an object.
    const partial = `${file}.${randomBytes(6).toString("hex")}.part`;
    try {
      await writeFile(partial, bytes, { mode: 0o600, flag: "wx" });
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.fileFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BlobMissing();
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }

  async signedReadUrl(_key: string, _ttlMs: number): Promise<string | null> {
    return null;
  }
}
