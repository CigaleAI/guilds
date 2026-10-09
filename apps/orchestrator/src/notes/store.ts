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
import { isRelativeTo, pythonQuote } from "../lib/contain.js";
import { AsyncLock } from "../lib/lock.js";
import {
  archiveFilename,
  archiveHeader,
  EMPTY_MEMORY,
  isRelativeMemoryArchivePath,
  LEGACY_MEMORY_DIR,
  MEMORY_ARCHIVE_KEEP,
  MEMORY_DIR,
  MEMORY_FILE,
} from "../memory/index.js";

export const FIXED_AGENT_FILES = ["task.md", MEMORY_FILE] as const;
export const SYSTEM_PROMPT = "system.md";
export const ROUTINES_DIR = "routines";
export const HOST_FOLDERS = ["notes", ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR] as const;

export class NotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesError";
  }
}

function resolved(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      return path.join(realpathSync(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export class NotesStore {
  root: string;
  templates: string;
  obsidianName: string;
  private readonly lock = new AsyncLock();

  constructor(root: string, templates: string, obsidianName: string) {
    this.root = existsSync(root) ? realpathSync(root) : path.resolve(root);
    this.templates = existsSync(templates) ? realpathSync(templates) : path.resolve(templates);
    this.obsidianName = obsidianName;
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
            this.migrateAgentLayout(agentDir);
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

  readSystemPrompt(): { path: string; obsidian: string; content: string } {
    const filePath = this.systemPath();
    if (!statIfFile(filePath)) {
      throw new NotesError("system.md not found");
    }
    const item = this.fileItem(filePath, SYSTEM_PROMPT);
    return { ...item, content: readFileSync(filePath, "utf8") };
  }

  notesRoot(scope: string, orgSlug: string, guildName: string, agentName: string): string {
    if (scope === "private") {
      return resolved(path.join(this.agentDir(orgSlug, guildName, agentName), "notes"));
    }
    if (scope === "shared") {
      return this.sharedDir(orgSlug, guildName);
    }
    throw new NotesError("scope must be private or shared");
  }

  repoPath(filePath: string): string {
    return posixRel(resolved(this.root), resolved(filePath));
  }

  resolveScopePath(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    relative: string,
    options: { markdown: boolean; allowEmpty?: boolean },
  ): string {
    const root = this.notesRoot(scope, orgSlug, guildName, agentName);
    const posix = this.scopeRel(relative, options.allowEmpty ?? false);
    let resolvedPath: string;
    if (posix === "") {
      resolvedPath = root;
    } else if (options.markdown && !posix.endsWith(".md")) {
      throw new NotesError("path must end in .md");
    } else if (posix.startsWith("orgs/")) {
      resolvedPath = resolved(path.join(this.root, posix));
    } else if (posix.startsWith("guilds/")) {
      resolvedPath = resolved(path.join(this.root, "orgs", orgSlug, posix));
    } else if (scope === "private") {
      const mapped = this.mapHostRel(posix);
      const first = mapped.split("/", 1)[0];
      if (first === ROUTINES_DIR || first === MEMORY_DIR || first === LEGACY_MEMORY_DIR) {
        resolvedPath = resolved(path.join(this.agentDir(orgSlug, guildName, agentName), mapped));
      } else {
        resolvedPath = resolved(path.join(root, mapped));
      }
    } else {
      resolvedPath = resolved(path.join(root, posix));
    }
    if (scope === "private") {
      resolvedPath = this.rewriteLegacyPrivate(resolvedPath, this.agentDir(orgSlug, guildName, agentName));
      if (!this.isPrivateAllowed(resolvedPath, this.agentDir(orgSlug, guildName, agentName), root)) {
        throw new NotesError("invalid path");
      }
      return resolvedPath;
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
    const privateRoot = this.notesRoot("private", orgSlug, guildName, agentName);
    const shared = this.notesRoot("shared", orgSlug, guildName, agentName);
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

  readNote(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    relative: string,
  ): [string, string] {
    const filePath = this.resolveScopePath(scope, orgSlug, guildName, agentName, relative, {
      markdown: true,
    });
    if (!statIfFile(filePath)) {
      throw new NotesError("file not found");
    }
    return [this.repoPath(filePath), readFileSync(filePath, "utf8")];
  }

  listNotes(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    prefix: string,
  ): string[] {
    const base = this.resolveScopePath(scope, orgSlug, guildName, agentName, prefix, {
      markdown: false,
      allowEmpty: true,
    });
    if (statIfFile(base)) {
      if (path.extname(base) !== ".md") {
        throw new NotesError("invalid path");
      }
      return [this.repoPath(base)];
    }
    const items = this.collectTree(base);
    if (scope === "private" && this.scopeRel(prefix, true) === "") {
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

  async writeNote(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    relative: string,
    content: string,
  ): Promise<string> {
    return this.lock.run(() =>
      this.writeNoteUnlocked(scope, orgSlug, guildName, agentName, relative, content),
    );
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
      const posix = this.relativePosix(relative);
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
      const filePath = this.resolveAgentFile(agent, posix);
      if (!statIfFile(filePath)) {
        if (
          !posix.startsWith("notes/") ||
          !posix.endsWith(".md") ||
          isRelativeMemoryArchivePath(posix) ||
          this.isRoutineRel(posix)
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
      const filePath = this.resolveSharedFile(shared, relative);
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
      const posix = this.relativePosix(relative);
      if ((FIXED_AGENT_FILES as readonly string[]).includes(posix)) {
        throw new NotesError("cannot delete this file");
      }
      if (isRelativeMemoryArchivePath(posix)) {
        throw new NotesError("memory archive notes cannot be deleted");
      }
      if (this.isRoutineRel(posix)) {
        throw new NotesError("routine notes cannot be deleted");
      }
      if (!posix.startsWith("notes/") || !posix.endsWith(".md")) {
        throw new NotesError("invalid path");
      }
      const filePath = this.resolveAgentFile(agent, posix);
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
      const filePath = this.resolveSharedFile(shared, relative);
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
    const filePath = this.resolveAgentFile(agent, relative);
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
    const filePath = this.resolveSharedFile(shared, relative);
    if (!statIfFile(filePath)) {
      throw new NotesError("file not found");
    }
    return readFileSync(filePath, "utf8");
  }

  routineRel(scheduleId: string): string {
    return `${ROUTINES_DIR}/${this.routineId(scheduleId)}.md`;
  }

  readRoutineNote(
    orgSlug: string,
    guildName: string,
    agentName: string,
    scheduleId: string,
  ): string | null {
    const filePath = this.routineFile(orgSlug, guildName, agentName, scheduleId);
    if (!statIfFile(filePath)) {
      return null;
    }
    return readFileSync(filePath, "utf8");
  }

  async writeRoutineNote(
    orgSlug: string,
    guildName: string,
    agentName: string,
    scheduleId: string,
    content: string,
  ): Promise<string> {
    return this.lock.run(() => {
      const filePath = this.routineFile(orgSlug, guildName, agentName, scheduleId);
      return this.writeFile(filePath, content);
    });
  }

  async deleteRoutineNote(
    orgSlug: string,
    guildName: string,
    agentName: string,
    scheduleId: string,
  ): Promise<void> {
    await this.lock.run(() => {
      const filePath = this.routineFile(orgSlug, guildName, agentName, scheduleId);
      if (statIfFile(filePath)) {
        unlinkSync(filePath);
      }
      const parent = path.dirname(filePath);
      if (isDir(parent) && readdirSync(parent).length === 0) {
        rmdirSync(parent);
      }
    });
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

  private writeNoteUnlocked(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    relative: string,
    content: string,
  ): string {
    const filePath = this.resolveScopePath(scope, orgSlug, guildName, agentName, relative, {
      markdown: true,
    });
    if (existsSync(filePath) && !statIfFile(filePath)) {
      throw new NotesError("invalid path");
    }
    if (this.isRoutineNote(scope, orgSlug, guildName, agentName, filePath)) {
      throw new NotesError("routine notes cannot be overwritten");
    }
    if (this.isMemoryArchiveNote(scope, orgSlug, guildName, agentName, filePath)) {
      throw new NotesError("memory archive notes cannot be overwritten");
    }
    return this.writeFile(filePath, content);
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

  private scopeRel(relative: string, allowEmpty: boolean): string {
    if (relative.startsWith("/") || path.isAbsolute(relative)) {
      throw new NotesError("invalid path");
    }
    const trimmed = relative.replace(/\/+$/, "");
    if (allowEmpty && (trimmed === "" || trimmed === ".")) {
      return "";
    }
    return this.relativePosix(trimmed);
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

  private migrateAgentLayout(agentDir: string): void {
    const notesDir = path.join(agentDir, "notes");
    this.liftDir(path.join(notesDir, ROUTINES_DIR), path.join(agentDir, ROUTINES_DIR));
    this.liftDir(path.join(notesDir, MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
    this.liftDir(path.join(notesDir, LEGACY_MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
    this.liftDir(path.join(agentDir, LEGACY_MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
  }

  private liftDir(source: string, dest: string): void {
    if (!isDir(source)) {
      return;
    }
    if (resolved(source) === resolved(dest)) {
      return;
    }
    if (!existsSync(dest)) {
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(source, dest);
      return;
    }
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(source)) {
      const child = path.join(source, name);
      if (!statIfFile(child)) {
        continue;
      }
      const target = path.join(dest, name);
      if (existsSync(target)) {
        unlinkSync(child);
      } else {
        renameSync(child, target);
      }
    }
    if (isDir(source) && readdirSync(source).length === 0) {
      rmdirSync(source);
    }
  }

  private routineId(scheduleId: string): string {
    const token = (scheduleId || "").trim();
    if (!token || token.includes("/") || token === "." || token === "..") {
      throw new NotesError("invalid path");
    }
    return token;
  }

  private routineFile(orgSlug: string, guildName: string, agentName: string, scheduleId: string): string {
    return resolved(
      path.join(this.agentDir(orgSlug, guildName, agentName), ROUTINES_DIR, `${this.routineId(scheduleId)}.md`),
    );
  }

  private isRoutineNote(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    filePath: string,
  ): boolean {
    return this.isPrivatePrefix(scope, orgSlug, guildName, agentName, filePath, ROUTINES_DIR);
  }

  private isMemoryArchiveNote(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    filePath: string,
  ): boolean {
    return [MEMORY_DIR, LEGACY_MEMORY_DIR].some((name) =>
      this.isPrivatePrefix(scope, orgSlug, guildName, agentName, filePath, name),
    );
  }

  private isPrivatePrefix(
    scope: string,
    orgSlug: string,
    guildName: string,
    agentName: string,
    filePath: string,
    prefix: string,
  ): boolean {
    if (scope !== "private") {
      return false;
    }
    const root = resolved(path.join(this.agentDir(orgSlug, guildName, agentName), prefix));
    const value = resolved(filePath);
    return value === root || isRelativeTo(value, root);
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

  private mapHostRel(posix: string): string {
    for (const name of [ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR]) {
      const old = `notes/${name}`;
      if (posix === old) {
        return name;
      }
      if (posix.startsWith(`${old}/`)) {
        return `${name}${posix.slice(old.length)}`;
      }
    }
    return posix;
  }

  private rewriteLegacyPrivate(value: string, agentDir: string): string {
    const notesDir = resolved(path.join(agentDir, "notes"));
    if (!isRelativeTo(value, notesDir)) {
      return value;
    }
    const rel = posixRel(notesDir, value);
    const mapped = this.mapHostRel(rel);
    if (mapped === rel) {
      return value;
    }
    return resolved(path.join(agentDir, mapped));
  }

  private isPrivateAllowed(value: string, agentDir: string, notesRoot: string): boolean {
    if (isRelativeTo(value, notesRoot)) {
      return true;
    }
    for (const name of [ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR]) {
      const special = resolved(path.join(agentDir, name));
      if (value === special || isRelativeTo(value, special)) {
        return true;
      }
    }
    return false;
  }

  private isRoutineRel(posix: string): boolean {
    const mapped = this.mapHostRel(posix);
    return mapped === ROUTINES_DIR || mapped.startsWith(`${ROUTINES_DIR}/`);
  }

  private guildDir(orgSlug: string, name: string): string {
    return resolved(path.join(this.root, "orgs", orgSlug, "guilds", name));
  }

  private sharedDir(orgSlug: string, name: string): string {
    return resolved(path.join(this.guildDir(orgSlug, name), "shared"));
  }

  private resolveAgentFile(agentDir: string, relative: string): string {
    const posix = this.mapHostRel(this.relativePosix(relative));
    const first = posix.split("/", 1)[0];
    if (!(FIXED_AGENT_FILES as readonly string[]).includes(posix) && !(HOST_FOLDERS as readonly string[]).includes(first ?? "")) {
      throw new NotesError("invalid path");
    }
    return this.contained(agentDir, posix);
  }

  private resolveSharedFile(sharedDir: string, relative: string): string {
    const posix = this.relativePosix(relative);
    if (!posix.endsWith(".md")) {
      throw new NotesError("invalid path");
    }
    return this.contained(sharedDir, posix);
  }

  private relativePosix(relative: string): string {
    if (!relative || relative.startsWith("/") || path.isAbsolute(relative)) {
      throw new NotesError("invalid path");
    }
    const parts = posixParts(relative);
    if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new NotesError("invalid path");
    }
    return parts.join("/");
  }

  private contained(root: string, posix: string): string {
    const candidate = resolved(path.join(root, posix));
    if (!isRelativeTo(candidate, resolved(root))) {
      throw new NotesError("invalid path");
    }
    return candidate;
  }

  private fileItem(absolute: string, relative: string): { path: string; obsidian: string } {
    const value = resolved(absolute);
    return {
      path: relative,
      obsidian: `obsidian://open?path=${pythonQuote(value)}`,
    };
  }
}

function isDir(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function statIfFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function posixParts(relative: string): string[] {
  return relative.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
}

function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function rglobAll(root: string): string[] {
  const items: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      items.push(child);
      if (isDir(child)) {
        walk(child);
      }
    }
  };
  walk(root);
  return items;
}

function rglobFiles(root: string): string[] {
  return rglobAll(root).filter((item) => statIfFile(item));
}
