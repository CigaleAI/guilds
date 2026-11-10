import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** An agent's home inside its machine, where its host directory is mounted. */
export function agentHome(agentId: string): string {
  return `/home/${agentId}`;
}

/** The home of the agent whose host directory this is: the directory is named after the agent. */
export function homeOfDirectory(workspaceDir: string): string {
  return agentHome(path.basename(path.resolve(workspaceDir)));
}

/**
 * Why a path an agent named cannot be used: it leaves the workspace (lexically or through a
 * link), names nothing, names something other than a regular file (or, read as a folder, other
 * than a folder), or is too large.
 */
export type AgentFileProblem = "outside" | "missing" | "not_file" | "too_large";

export class AgentFileError extends Error {
  readonly problem: AgentFileProblem;
  /** The file's size, for a `too_large` refusal. */
  readonly size: number | undefined;

  constructor(message: string, problem: AgentFileProblem = "outside", size?: number) {
    super(message);
    this.name = "AgentFileError";
    this.problem = problem;
    this.size = size;
  }
}

/**
 * A path an agent named, on the host: absolute under its home, or relative to it. `workspaceDir`
 * is the agent's host directory.
 */
export function resolveAgentFilePath(workspaceDir: string, filePath: string): string {
  const home = homeOfDirectory(workspaceDir);
  let relative = filePath.trim();
  if (!relative) {
    throw new AgentFileError("file_path is required");
  }
  if (relative === home || relative.startsWith(`${home}/`)) {
    relative = relative.slice(home.length).replace(/^\/+/, "");
  }
  if (path.isAbsolute(relative)) {
    throw new AgentFileError(`file_path must be under ${home}`);
  }
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AgentFileError(`file_path must be under ${home}`);
  }
  return resolved;
}

/** A host path in the agent's directory as the agent sees it, under its home. */
export function agentDisplayPath(workspaceDir: string, resolved: string): string {
  const home = homeOfDirectory(workspaceDir);
  const root = path.resolve(workspaceDir);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".") {
    return home;
  }
  return `${home}/${rel.split(path.sep).join("/")}`;
}

function inside(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The tool parameter a refusal names an agent's path by. */
type AgentPathParameter = "file_path" | "folder_path";

function linkOut(workspaceDir: string, parameter: AgentPathParameter): string {
  return `${parameter} must be under ${homeOfDirectory(workspaceDir)}, not a link out of it`;
}

/**
 * Where a path resolved in an agent's workspace leads once every link is followed. Refused as
 * `missing`, naming the path by `parameter`, when it leads nowhere.
 */
async function followAgentPath(resolved: string, parameter: AgentPathParameter): Promise<string> {
  try {
    return await realpath(resolved);
  } catch {
    throw new AgentFileError(`${parameter} was not found in the agent workspace`, "missing");
  }
}

function throughFolders(workspaceDir: string): string {
  return `file_path must be under ${homeOfDirectory(workspaceDir)} through folders, not links`;
}

/** A file an agent named, read: its path on the host and its bytes. */
export type AgentFile = { path: string; bytes: Buffer };

/**
 * Reads a file an agent named in its workspace. The workspace is the agent's folder on this
 * host, which its machine mounts at /home/<agent id>, so a link the agent planted there resolves
 * against the orchestrator's filesystem when the orchestrator opens it. The path therefore has to
 * stay in the workspace once every link is followed, and name a regular file; it is opened without
 * following a link and without blocking, and must still be the file that was checked.
 */
export async function readAgentFile(
  workspaceDir: string,
  filePath: string,
  maxBytes: number,
): Promise<AgentFile> {
  const resolved = resolveAgentFilePath(workspaceDir, filePath);
  const real = await followAgentPath(resolved, "file_path");
  if (!inside(await realpath(workspaceDir), real)) {
    throw new AgentFileError(linkOut(workspaceDir, "file_path"));
  }
  const checked = await lstat(real);
  if (!checked.isFile()) {
    throw new AgentFileError("file_path must be a regular file", "not_file");
  }
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new AgentFileError(linkOut(workspaceDir, "file_path"));
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(info, checked)) {
      throw new AgentFileError(linkOut(workspaceDir, "file_path"));
    }
    if (info.size > maxBytes) {
      throw new AgentFileError(`file_path is larger than ${maxBytes} bytes`, "too_large", info.size);
    }
    // One byte past the size it reported shows a file that grew while it was read.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length !== info.size) {
      throw new AgentFileError("file_path changed while it was read", "not_file");
    }
    return { path: resolved, bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

/** One file of a folder an agent named: its path in the folder, with `/` between parts, and its bytes. */
export type AgentFolderFile = { path: string; bytes: Buffer };

/** A folder an agent named, read: its path on the host and its files. */
export type AgentFolder = { path: string; files: AgentFolderFile[] };

/**
 * Reads every file under a folder an agent named in its workspace, sorted by path. The folder has
 * to stay in the workspace once every link is followed, and each file is read as `readAgentFile`
 * reads one. A link to a folder is not followed: it is refused as not a regular file. Refuses a
 * folder holding more than `maxFiles` files or more than `maxBytes` bytes in all.
 */
export async function readAgentFolder(
  workspaceDir: string,
  folderPath: string,
  maxFiles: number,
  maxBytes: number,
): Promise<AgentFolder> {
  const resolved = resolveAgentFilePath(workspaceDir, folderPath);
  const root = await realpath(workspaceDir);
  const real = await followAgentPath(resolved, "folder_path");
  if (real === root) {
    throw new AgentFileError(`folder_path must be a folder under ${homeOfDirectory(workspaceDir)}, not the home itself`);
  }
  if (!inside(root, real)) {
    throw new AgentFileError(linkOut(workspaceDir, "folder_path"));
  }
  if (!(await lstat(real)).isDirectory()) {
    throw new AgentFileError("folder_path must be a folder", "not_file");
  }
  const names: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), name);
        continue;
      }
      names.push(name);
      if (names.length > maxFiles) {
        throw new AgentFileError(`folder_path holds more than ${maxFiles} files`, "too_large");
      }
    }
  };
  await walk(real, "");
  names.sort();
  const base = path.relative(root, real);
  const files: AgentFolderFile[] = [];
  let total = 0;
  for (const name of names) {
    let read: AgentFile;
    try {
      read = await readAgentFile(workspaceDir, path.join(base, ...name.split("/")), maxBytes - total);
    } catch (error) {
      if (!(error instanceof AgentFileError)) {
        throw error;
      }
      if (error.problem === "too_large") {
        throw new AgentFileError(`folder_path holds more than ${maxBytes} bytes`, "too_large");
      }
      throw new AgentFileError(`${name}: ${error.message}`, error.problem);
    }
    total += read.bytes.length;
    files.push({ path: name, bytes: read.bytes });
  }
  return { path: resolved, files };
}

/**
 * Writes bytes to a path an agent named in its workspace, creating missing folders. Every part of
 * the path that exists must be a real folder in the workspace, never a link, and the file is
 * created or replaced without following a link at its name, so a planted link cannot turn the
 * write onto the orchestrator's own files. Returns the resolved path.
 */
export async function writeAgentFile(workspaceDir: string, filePath: string, bytes: Uint8Array): Promise<string> {
  const resolved = resolveAgentFilePath(workspaceDir, filePath);
  const parts = path.relative(path.resolve(workspaceDir), resolved).split(path.sep).filter(Boolean);
  const name = parts.pop();
  if (!name) {
    throw new AgentFileError("file_path must name a file", "not_file");
  }
  let current: string;
  try {
    current = await realpath(workspaceDir);
  } catch {
    throw new AgentFileError("the agent workspace does not exist", "missing");
  }
  for (const part of parts) {
    current = path.join(current, part);
    const found = await lstat(current).catch(() => null);
    if (found === null) {
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const made = await lstat(current);
      if (!made.isDirectory()) {
        throw new AgentFileError(throughFolders(workspaceDir));
      }
    } else if (!found.isDirectory()) {
      throw new AgentFileError(throughFolders(workspaceDir));
    }
  }
  const target = path.join(current, name);
  const existing = await lstat(target).catch(() => null);
  if (existing !== null && !existing.isFile()) {
    throw new AgentFileError("file_path must name a regular file, not a link or folder", "not_file");
  }
  let handle: FileHandle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o644,
    );
  } catch {
    throw new AgentFileError("file_path must name a regular file, not a link or folder", "not_file");
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new AgentFileError("file_path must name a regular file, not a link or folder", "not_file");
    }
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return resolved;
}
