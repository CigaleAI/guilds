import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AttachmentError, type BlobStore } from "./types.js";

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async get(key: string): Promise<Buffer> {
    const row = this.objects.get(key);
    if (!row) {
      throw new AttachmentError(404, "attachment not found");
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
 * Objects as files under one directory, a key's `/` a subdirectory. The store serves bytes only:
 * a model request carries the image itself.
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
      throw new AttachmentError(404, "attachment not found");
    }
    const file = path.join(this.root, ...segments);
    if (!file.startsWith(this.root + path.sep)) {
      throw new AttachmentError(404, "attachment not found");
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
        throw new AttachmentError(404, "attachment not found");
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
