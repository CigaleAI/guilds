import { gunzipSync, gzipSync } from "node:zlib";
import { RegistryPackageError } from "./index.js";

/** The largest package the client unpacks, packed or not. */
export const PACKAGE_MAX_BYTES = 16 * 1024 * 1024;

/** The ustar type flags of the entries a read skips: a directory, and the pax extended headers. */
const SKIPPED_TYPES = new Set(["5", "x", "g"]);

/** One ustar header's fields: the entry's name, its size in bytes, and its type flag. */
type TarHeader = { name: string; size: number; type: string };

/** The fields of a 512-byte ustar header; refuses a size that is not a non-negative octal number. */
function readTarHeader(header: Buffer): TarHeader {
  const field = (start: number, length: number): string =>
    header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const prefix = field(345, 155);
  const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
  const size = Number.parseInt(field(124, 12).trim() || "0", 8);
  if (!Number.isFinite(size) || size < 0) {
    throw new RegistryPackageError(`package entry ${name} has no valid size`);
  }
  return { name, size, type: field(156, 1) || "0" };
}

/**
 * The path a regular file is read to, or null for an entry that is skipped. Refuses a link, a
 * device, and a path that climbs out of the archive.
 */
function regularFilePath(header: TarHeader): string | null {
  if (SKIPPED_TYPES.has(header.type)) {
    return null;
  }
  if (header.type !== "0") {
    throw new RegistryPackageError(`package entry ${header.name} is not a regular file`);
  }
  const path = header.name.replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new RegistryPackageError(`package entry ${header.name} leaves the archive`);
  }
  return path;
}

/**
 * The regular files of a gzipped ustar archive, by path. Directories are skipped; links, devices,
 * and any path that climbs out of the archive are refused.
 */
export function readTarball(bytes: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: PACKAGE_MAX_BYTES });
  } catch {
    throw new RegistryPackageError("package is not a gzipped archive within the size limit");
  }
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const header = readTarHeader(block);
    const body = offset + 512;
    if (body + header.size > tar.length) {
      throw new RegistryPackageError(`package entry ${header.name} is truncated`);
    }
    const path = regularFilePath(header);
    if (path !== null) {
      files.set(path, Buffer.from(tar.subarray(body, body + header.size)));
    }
    offset = body + Math.ceil(header.size / 512) * 512;
  }
  return files;
}

/** A gzipped ustar archive of `files`, by path, in the order given. */
export function packTarball(files: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of files) {
    if (Buffer.byteLength(name) > 100) {
      throw new RegistryPackageError(`package path ${name} exceeds 100 bytes`);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
