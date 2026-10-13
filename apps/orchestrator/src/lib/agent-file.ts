import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
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
 * link), names nothing, names something other than a regular file, or is too large.
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

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function linkOut(workspaceDir: string): string {
  return `file_path must be under ${homeOfDirectory(workspaceDir)}, not a link out of it`;
}

function throughFolders(workspaceDir: string): string {
  return `file_path must be under ${homeOfDirectory(workspaceDir)} through folders, not links`;
}

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
  options: { maxBytes: number },
): Promise<{ path: string; bytes: Buffer }> {
  const resolved = resolveAgentFilePath(workspaceDir, filePath);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new AgentFileError("file_path was not found in the agent workspace", "missing");
  }
  if (!inside(await realpath(workspaceDir), real)) {
    throw new AgentFileError(linkOut(workspaceDir));
  }
  const checked = await lstat(real);
  if (!checked.isFile()) {
    throw new AgentFileError("file_path must be a regular file", "not_file");
  }
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new AgentFileError(linkOut(workspaceDir));
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(info, checked)) {
      throw new AgentFileError(linkOut(workspaceDir));
    }
    if (info.size > options.maxBytes) {
      throw new AgentFileError(`file_path is larger than ${options.maxBytes} bytes`, "too_large", info.size);
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
