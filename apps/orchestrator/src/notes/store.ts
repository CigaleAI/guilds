import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { EMPTY_MEMORY } from "../artifacts/memory.js";
import { isRelativeTo, pythonQuote } from "../lib/contain.js";
import { AsyncLock } from "../lib/lock.js";
import {
  archiveFilename,
  archiveHeader,
  isRelativeMemoryArchivePath,
  LEGACY_MEMORY_DIR,
  MEMORY_ARCHIVE_KEEP,
  MEMORY_DIR,
  MEMORY_FILE,
} from "../memory/index.js";
import { NotesError } from "./errors.js";
import { migrateAgentLayout } from "./migrate.js";
import {
  FIXED_AGENT_FILES,
  HOST_FOLDERS,
  isDir,
  isInAgentFolder,
  isPrivateAllowed,
  isRoutineRel,
  mapHostRel,
  notePosix,
  posixParts,
  posixRel,
  prefixPosix,
  relativePosix,
  resolveAgentFile,
  resolved,
  resolveSharedFile,
  rewriteLegacyPrivate,
  rglobAll,
  rglobFiles,
  ROUTINES_DIR,
  statIfFile,
} from "./paths.js";

export const SYSTEM_PROMPT = "system.md";

export class NotesStore {
  root: string;
  templates: string;
  private readonly lock = new AsyncLock();

  constructor(root: string, templates: string) {
    this.root = existsSync(root) ? realpathSync(root) : path.resolve(root);
    this.templates = existsSync(templates) ? realpathSync(templates) : path.resolve(templates);
  }

  async createGuild(orgSlug: string, name: string): Promise<void> {
    await this.lock.run(() => this.createGuildUnlocked(orgSlug, name));
  }

  async createAgent(orgSlug: string, guildName: string, name: string, task = ""): Promise<void> {
    await this.lock.run(() => this.createAgentUnlocked(orgSlug, guildName, name, task));
  }

  async deleteAgent(orgSlug: string, guildName: string, name: string): Promise<void> {
    await this.lock.run(() => this.deleteAgentUnlocked(orgSlug, guildName, name));
  }

  async deleteGuild(orgSlug: string, name: string): Promise<void> {
    await this.lock.run(() => this.deleteGuildUnlocked(orgSlug, name));
  }

  async renameGuild(orgSlug: string, from: string, to: string): Promise<void> {
    await this.lock.run(() => this.renameGuildUnlocked(orgSlug, from, to));
  }

  /** Moves an organisation's folder to its new slug; a folder already at the new slug stays as it is. */
  async renameOrg(from: string, to: string): Promise<void> {
    await this.lock.run(() => {
      const source = path.join(this.root, "orgs", from);
      const dest = path.join(this.root, "orgs", to);
      if (existsSync(source) && !existsSync(dest)) {
        renameSync(source, dest);
      }
    });
  }

  async renameAgent(orgSlug: string, guildName: string, from: string, to: string): Promise<void> {
    await this.lock.run(() => this.renameAgentUnlocked(orgSlug, guildName, from, to));
  }

  async ensureSystemPrompt(): Promise<void> {
    if (!statIfFile(this.systemPath())) {
      throw new NotesError("system prompt template is missing");
    }
  }

  async ensureMemoryFiles(): Promise<void> {
    await this.lock.run(() => {
      const orgs = path.join(this.root, "orgs");
      if (!isDir(orgs)) {
        return;
      }
      for (const orgName of readdirSync(orgs)) {
        const guilds = path.join(orgs, orgName, "guilds");
        if (!isDir(guilds)) {
          continue;
        }
        for (const guildName of readdirSync(guilds)) {
          const agents = path.join(guilds, guildName, "agents");
          if (!isDir(agents)) {
            continue;
          }
          for (const agentName of readdirSync(agents)) {
            const agentDir = path.join(agents, agentName);
            if (!isDir(agentDir)) {
              continue;
            }
            migrateAgentLayout(agentDir);
            const filePath = path.join(agentDir, MEMORY_FILE);
            if (!statIfFile(filePath)) {
              writeFileSync(filePath, EMPTY_MEMORY, "utf8");
            }
          }
        }
      }
    });
  }

  systemPath(): string {
    return resolved(path.join(this.templates, SYSTEM_PROMPT));
  }

  private privateNotesRoot(orgSlug: string, guildName: string, agentName: string): string {
    return resolved(path.join(this.agentDir(orgSlug, guildName, agentName), "notes"));
  }

  repoPath(filePath: string): string {
    return posixRel(resolved(this.root), resolved(filePath));
  }

  /**
   * A path in the agent's private notes, from a checked posix path (`""` is the notes root): a
   * repository path under `orgs/` or `guilds/`, else one in its notes, its routines, or its
   * Memory archive. Throws when it leaves them.
   */
  private resolvePrivatePath(orgSlug: string, guildName: string, agentName: string, posix: string): string {
    const agent = this.agentDir(orgSlug, guildName, agentName);
    const root = this.privateNotesRoot(orgSlug, guildName, agentName);
    let resolvedPath: string;
    if (posix === "") {
      resolvedPath = root;
    } else if (posix.startsWith("orgs/")) {
      resolvedPath = resolved(path.join(this.root, posix));
    } else if (posix.startsWith("guilds/")) {
      resolvedPath = resolved(path.join(this.root, "orgs", orgSlug, posix));
    } else {
      const mapped = mapHostRel(posix);
      const first = mapped.split("/", 1)[0];
      if (first === ROUTINES_DIR || first === MEMORY_DIR || first === LEGACY_MEMORY_DIR) {
        resolvedPath = resolved(path.join(agent, mapped));
      } else {
        resolvedPath = resolved(path.join(root, mapped));
      }
    }
    resolvedPath = rewriteLegacyPrivate(resolvedPath, agent);
    if (!isPrivateAllowed(resolvedPath, agent, root)) {
      throw new NotesError("invalid path");
    }
    return resolvedPath;
  }

  /**
   * A path in the guild's shared notes, from a checked posix path (`""` is the shared folder): a
   * repository path under `orgs/` or `guilds/`, else one in the folder. Throws when it leaves it.
   */
  private resolveSharedPath(orgSlug: string, guildName: string, posix: string): string {
    const root = this.sharedDir(orgSlug, guildName);
    let resolvedPath: string;
    if (posix === "") {
      resolvedPath = root;
    } else if (posix.startsWith("orgs/")) {
      resolvedPath = resolved(path.join(this.root, posix));
    } else if (posix.startsWith("guilds/")) {
      resolvedPath = resolved(path.join(this.root, "orgs", orgSlug, posix));
    } else {
      resolvedPath = resolved(path.join(root, posix));
    }
    if (!isRelativeTo(resolvedPath, root)) {
      throw new NotesError("invalid path");
    }
    return resolvedPath;
  }

  expandWikilinks(text: string, orgSlug: string, guildName: string, agentName: string): string {
    return text.replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
      let target = inner;
      let alias: string | undefined;
      if (target.includes("|")) {
        const parts = target.split("|");
        target = parts[0] ?? "";
        alias = parts.slice(1).join("|");
      }
      let heading: string | undefined;
      if (target.includes("#")) {
        const parts = target.split("#");
        target = parts[0] ?? "";
        heading = parts.slice(1).join("#");
      }
      const canonical = this.resolveWikilink(orgSlug, guildName, agentName, target.trim());
      if (canonical === null) {
        return whole;
      }
      let rebuilt = canonical;
      if (heading !== undefined) {
        rebuilt = `${rebuilt}#${heading}`;
      }
      if (alias !== undefined) {
        rebuilt = `${rebuilt}|${alias}`;
      }
      return `[[${rebuilt}]]`;
    });
  }

  resolveWikilink(
    orgSlug: string,
    guildName: string,
    agentName: string,
    target: string,
  ): string | null {
    let value = target.trim().replaceAll("\\", "/");
    if (value.endsWith(".md")) {
      value = value.slice(0, -".md".length);
    }
    if (!value || value.startsWith("/") || path.isAbsolute(value)) {
      return null;
    }
    const parts = posixParts(value);
    if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) {
      return null;
    }
    const privateRoot = this.privateNotesRoot(orgSlug, guildName, agentName);
    const shared = this.sharedDir(orgSlug, guildName);
    let candidate = resolved(path.join(this.root, `${value}.md`));
    if (!statIfFile(candidate) && value.startsWith("guilds/")) {
      candidate = resolved(path.join(this.root, "orgs", orgSlug, `${value}.md`));
    }
    if (statIfFile(candidate) && (isRelativeTo(candidate, privateRoot) || isRelativeTo(candidate, shared))) {
      return this.repoPath(candidate).replace(/\.md$/, "");
    }
    if (value.includes("/")) {
      return null;
    }
    const matches: string[] = [];
    for (const root of [privateRoot, shared]) {
      if (!isDir(root)) {
        continue;
      }
      const found = rglobFiles(root)
        .filter((child) => path.basename(child) === `${path.posix.basename(value)}.md`)
        .filter((child) => isRelativeTo(resolved(child), root));
      if (found.length > 1) {
        return null;
      }
      if (found.length === 1 && found[0]) {
        matches.push(found[0]);
      }
    }
    if (!matches.length) {
      return null;
    }
    return this.repoPath(matches[0]!).replace(/\.md$/, "");
  }

  /** A note of the agent's private notes: its repository path and its text. */
  readPrivateNote(orgSlug: string, guildName: string, agentName: string, relative: string): [string, string] {
    const filePath = this.resolvePrivatePath(orgSlug, guildName, agentName, notePosix(relative));
    if (!statIfFile(filePath)) {
      throw new NotesError("file not found");
    }
    return [this.repoPath(filePath), readFileSync(filePath, "utf8")];
  }

  /**
   * The repository paths of the agent's private notes under a prefix, folders ending in `/`. At
   * the root, its routines and Memory archive are listed too.
   */
  listPrivateNotes(orgSlug: string, guildName: string, agentName: string, prefix: string): string[] {
    const posix = prefixPosix(prefix);
    const base = this.resolvePrivatePath(orgSlug, guildName, agentName, posix);
    if (statIfFile(base)) {
      if (path.extname(base) !== ".md") {
        throw new NotesError("invalid path");
      }
      return [this.repoPath(base)];
    }
    const items = this.collectTree(base);
    if (posix === "") {
      const agent = this.agentDir(orgSlug, guildName, agentName);
      for (const name of [ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR]) {
        const special = path.join(agent, name);
        const children = this.collectTree(special);
        if (children.length) {
          items.push(`${this.repoPath(special)}/`);
          items.push(...children);
        }
      }
      items.sort();
    }
    return items;
  }

  /** The repository paths of the guild's shared notes under a prefix, folders ending in `/`. */
  listSharedNotes(orgSlug: string, guildName: string, prefix: string): string[] {
    const base = this.resolveSharedPath(orgSlug, guildName, prefixPosix(prefix));
    if (statIfFile(base)) {
      if (path.extname(base) !== ".md") {
        throw new NotesError("invalid path");
      }
      return [this.repoPath(base)];
    }
    return this.collectTree(base);
  }

  /**
   * Writes a note of the agent's private notes and answers its repository path. Its routines and
   * its Memory archive are refused.
   */
  async writePrivateNote(
    orgSlug: string,
    guildName: string,
    agentName: string,
    relative: string,
    content: string,
  ): Promise<string> {
    return this.lock.run(() => {
      const filePath = this.resolvePrivatePath(orgSlug, guildName, agentName, notePosix(relative));
      if (existsSync(filePath) && !statIfFile(filePath)) {
        throw new NotesError("invalid path");
      }
      const agent = this.agentDir(orgSlug, guildName, agentName);
      if (isInAgentFolder(agent, ROUTINES_DIR, filePath)) {
        throw new NotesError("routine notes cannot be overwritten");
      }
      if ([MEMORY_DIR, LEGACY_MEMORY_DIR].some((name) => isInAgentFolder(agent, name, filePath))) {
        throw new NotesError("memory archive notes cannot be overwritten");
      }
      return this.writeFile(filePath, content);
    });
  }

  async writeAgentFile(
    orgSlug: string,
    guildName: string,
    name: string,
    relative: string,
    content: string,
    options: { actor?: string | null } = {},
  ): Promise<string> {
    return this.lock.run(() => {
      const agent = this.agentDir(orgSlug, guildName, name);
      if (!isDir(agent)) {
        throw new NotesError("agent folder not found");
      }
      const posix = relativePosix(relative);
      if (!posix.endsWith(".md")) {
        throw new NotesError("path must end in .md");
      }
      if (isRelativeMemoryArchivePath(posix)) {
        throw new NotesError("memory archive notes cannot be overwritten");
      }
      if (posix === MEMORY_FILE) {
        if (!options.actor) {
          throw new NotesError("memory writes require an actor");
        }
        return this.writeMemoryUnlocked(orgSlug, guildName, name, content, {
          source: options.actor,
          replacedBy: `user ${options.actor} (Files pane)`,
        });
      }
      const filePath = resolveAgentFile(agent, posix);
      if (!statIfFile(filePath)) {
        if (
          !posix.startsWith("notes/") ||
          !posix.endsWith(".md") ||
          isRelativeMemoryArchivePath(posix) ||
          isRoutineRel(posix)
        ) {
          throw new NotesError("file not found");
        }
      }
      return this.writeFile(filePath, content);
    });
  }

  async writeMemory(
    orgSlug: string,
    guildName: string,
    agentName: string,
    content: string,
    options: { source: string; replacedBy: string },
  ): Promise<string> {
    return this.lock.run(() =>
      this.writeMemoryUnlocked(orgSlug, guildName, agentName, content, options),
    );
  }

  async writeSharedFile(
    orgSlug: string,
    guildName: string,
    relative: string,
    content: string,
  ): Promise<string> {
    return this.lock.run(() => {
      const shared = this.sharedDir(orgSlug, guildName);
      if (!isDir(shared)) {
        throw new NotesError("shared folder not found");
      }
      const filePath = resolveSharedFile(shared, relative);
      return this.writeFile(filePath, content);
    });
  }

  async deleteAgentFile(
    orgSlug: string,
    guildName: string,
    name: string,
    relative: string,
  ): Promise<void> {
    await this.lock.run(() => {
      const agent = this.agentDir(orgSlug, guildName, name);
      if (!isDir(agent)) {
        throw new NotesError("agent folder not found");
      }
      const posix = relativePosix(relative);
      if ((FIXED_AGENT_FILES as readonly string[]).includes(posix)) {
        throw new NotesError("cannot delete this file");
      }
      if (isRelativeMemoryArchivePath(posix)) {
        throw new NotesError("memory archive notes cannot be deleted");
      }
      if (isRoutineRel(posix)) {
        throw new NotesError("routine notes cannot be deleted");
      }
      if (!posix.startsWith("notes/") || !posix.endsWith(".md")) {
        throw new NotesError("invalid path");
      }
      const filePath = resolveAgentFile(agent, posix);
      if (!statIfFile(filePath)) {
        throw new NotesError("file not found");
      }
      unlinkSync(filePath);
      this.pruneEmptyParents(filePath, path.join(agent, "notes"));
    });
  }

  async deleteSharedFile(orgSlug: string, guildName: string, relative: string): Promise<void> {
    await this.lock.run(() => {
      const shared = this.sharedDir(orgSlug, guildName);
      if (!isDir(shared)) {
        throw new NotesError("shared folder not found");
      }
      const filePath = resolveSharedFile(shared, relative);
      if (!statIfFile(filePath)) {
        throw new NotesError("file not found");
      }
      unlinkSync(filePath);
      this.pruneEmptyParents(filePath, shared);
    });
  }

  listAgentFiles(orgSlug: string, guildName: string, name: string): Array<{ path: string; obsidian: string }> {
    const agent = this.agentDir(orgSlug, guildName, name);
    if (!isDir(agent)) {
      throw new NotesError("agent folder not found");
    }
    const paths: string[] = [];
    for (const relative of FIXED_AGENT_FILES) {
      if (statIfFile(path.join(agent, relative))) {
        paths.push(relative);
      }
    }
    for (const folder of HOST_FOLDERS) {
      const directory = path.join(agent, folder);
      if (!isDir(directory)) {
        continue;
      }
      for (const child of rglobAll(directory).sort()) {
        if (statIfFile(child) && path.basename(child) !== ".gitkeep") {
          paths.push(posixRel(agent, child));
        }
      }
    }
    return paths.map((relative) => this.fileItem(path.join(agent, relative), relative));
  }

  readAgentFile(orgSlug: string, guildName: string, name: string, relative: string): string {
    const agent = this.agentDir(orgSlug, guildName, name);
    if (!isDir(agent)) {
      throw new NotesError("agent folder not found");
    }
    const filePath = resolveAgentFile(agent, relative);
    if (!statIfFile(filePath)) {
      throw new NotesError("file not found");
    }
    return readFileSync(filePath, "utf8");
  }

  listSharedFiles(orgSlug: string, guildName: string): Array<{ path: string; obsidian: string }> {
    const shared = this.sharedDir(orgSlug, guildName);
    if (!isDir(shared)) {
      throw new NotesError("shared folder not found");
    }
    const items: Array<{ path: string; obsidian: string }> = [];
    for (const child of rglobFiles(shared)
      .filter((item) => path.extname(item) === ".md")
      .sort()) {
      if (statIfFile(child)) {
        items.push(this.fileItem(child, posixRel(shared, child)));
      }
    }
    return items;
  }

  readSharedFile(orgSlug: string, guildName: string, relative: string): string {
    const shared = this.sharedDir(orgSlug, guildName);
    if (!isDir(shared)) {
      throw new NotesError("shared folder not found");
    }
    const filePath = resolveSharedFile(shared, relative);
    if (!statIfFile(filePath)) {
      throw new NotesError("file not found");
    }
    return readFileSync(filePath, "utf8");
  }

  agentDir(orgSlug: string, guildName: string, name: string): string {
    return resolved(path.join(this.guildDir(orgSlug, guildName), "agents", name));
  }

  private async createGuildUnlocked(orgSlug: string, name: string): Promise<void> {
    const dest = this.guildDir(orgSlug, name);
    if (existsSync(dest)) {
      throw new NotesError(`guild folder already exists: ${name}`);
    }
    try {
      mkdirSync(path.join(dest, "shared"), { recursive: true });
    } catch (error) {
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async createAgentUnlocked(
    orgSlug: string,
    guildName: string,
    name: string,
    task = "",
  ): Promise<void> {
    const guild = this.guildDir(orgSlug, guildName);
    if (!isDir(guild)) {
      throw new NotesError(`guild folder not found: ${guildName}`);
    }
    const dest = path.join(guild, "agents", name);
    if (existsSync(dest)) {
      throw new NotesError(`agent folder already exists: ${name}`);
    }
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      mkdirSync(dest);
      const text = (task || "").trim();
      if (text) {
        writeFileSync(path.join(dest, "task.md"), `${text}\n`, "utf8");
      } else {
        copyFileSync(path.join(this.templates, "task.md"), path.join(dest, "task.md"));
      }
      const memorySrc = path.join(this.templates, MEMORY_FILE);
      if (statIfFile(memorySrc)) {
        copyFileSync(memorySrc, path.join(dest, MEMORY_FILE));
      } else {
        writeFileSync(path.join(dest, MEMORY_FILE), EMPTY_MEMORY, "utf8");
      }
      for (const folder of ["notes", ROUTINES_DIR, MEMORY_DIR]) {
        mkdirSync(path.join(dest, folder));
      }
    } catch (error) {
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private deleteAgentUnlocked(orgSlug: string, guildName: string, name: string): void {
    const dest = this.agentDir(orgSlug, guildName, name);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }
  }

  private deleteGuildUnlocked(orgSlug: string, name: string): void {
    const dest = this.guildDir(orgSlug, name);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }
  }

  private renameGuildUnlocked(orgSlug: string, from: string, to: string): void {
    if (from === to) {
      return;
    }
    const source = this.guildDir(orgSlug, from);
    const dest = this.guildDir(orgSlug, to);
    if (!existsSync(source)) {
      return;
    }
    if (existsSync(dest)) {
      throw new NotesError(`guild folder already exists: ${to}`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(source, dest);
  }

  private renameAgentUnlocked(orgSlug: string, guildName: string, from: string, to: string): void {
    if (from === to) {
      return;
    }
    const source = this.agentDir(orgSlug, guildName, from);
    const dest = this.agentDir(orgSlug, guildName, to);
    if (!existsSync(source)) {
      return;
    }
    if (existsSync(dest)) {
      throw new NotesError(`agent folder already exists: ${to}`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(source, dest);
  }

  private writeFile(filePath: string, content: string): string {
    const repo = this.repoPath(filePath);
    const previous = statIfFile(filePath) ? readFileSync(filePath, "utf8") : null;
    const created = !existsSync(filePath);
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
      return repo;
    } catch (error) {
      if (created && existsSync(filePath)) {
        unlinkSync(filePath);
      } else if (previous !== null) {
        writeFileSync(filePath, previous, "utf8");
      }
      throw error;
    }
  }

  private pruneEmptyParents(filePath: string, stop: string): void {
    let parent = resolved(path.dirname(filePath));
    const end = resolved(stop);
    while (parent !== end && isRelativeTo(parent, end)) {
      if (!isDir(parent) || readdirSync(parent).length > 0) {
        break;
      }
      rmdirSync(parent);
      parent = path.dirname(parent);
    }
  }

  private writeMemoryUnlocked(
    orgSlug: string,
    guildName: string,
    agentName: string,
    content: string,
    options: { source: string; replacedBy: string },
  ): string {
    const agent = this.agentDir(orgSlug, guildName, agentName);
    if (!isDir(agent)) {
      throw new NotesError("agent folder not found");
    }
    const filePath = path.join(agent, MEMORY_FILE);
    const previous = statIfFile(filePath) ? readFileSync(filePath, "utf8") : null;
    if (previous !== null && previous === content) {
      return "memory.md unchanged";
    }
    const now = new Date();
    let archivedName = "";
    if (previous !== null) {
      const started = statSync(filePath).mtime;
      archivedName = archiveFilename(now, options.source);
      const archivePath = path.join(this.agentDir(orgSlug, guildName, agentName), MEMORY_DIR, archivedName);
      const header = archiveHeader({ started, ended: now, replacedBy: options.replacedBy });
      this.writeFile(archivePath, `${header}\n${previous}`);
      this.pruneMemoryArchive(orgSlug, guildName, agentName);
    }
    this.writeFile(filePath, content);
    if (archivedName) {
      return `memory.md written; previous archived as ${MEMORY_DIR}/${archivedName}`;
    }
    return "memory.md written";
  }

  private pruneMemoryArchive(orgSlug: string, guildName: string, agentName: string): void {
    const root = resolved(path.join(this.agentDir(orgSlug, guildName, agentName), MEMORY_DIR));
    if (!isDir(root)) {
      return;
    }
    const files = readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((child) => statIfFile(child) && path.extname(child) === ".md")
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - MEMORY_ARCHIVE_KEEP))) {
      unlinkSync(old);
    }
  }

  private collectTree(base: string): string[] {
    if (!isDir(base)) {
      return [];
    }
    const root = resolved(base);
    const items: string[] = [];
    for (const child of rglobAll(base).sort()) {
      if (path.basename(child) === ".gitkeep") {
        continue;
      }
      const value = resolved(child);
      if (!isRelativeTo(value, root)) {
        continue;
      }
      if (isDir(child)) {
        items.push(`${this.repoPath(child)}/`);
      } else if (statIfFile(child) && path.extname(child) === ".md") {
        items.push(this.repoPath(child));
      }
    }
    return items;
  }

  private guildDir(orgSlug: string, name: string): string {
    return resolved(path.join(this.root, "orgs", orgSlug, "guilds", name));
  }

  private sharedDir(orgSlug: string, name: string): string {
    return resolved(path.join(this.guildDir(orgSlug, name), "shared"));
  }

  private fileItem(absolute: string, relative: string): { path: string; obsidian: string } {
    const value = resolved(absolute);
    return {
      path: relative,
      obsidian: `obsidian://open?path=${pythonQuote(value)}`,
    };
  }
}
