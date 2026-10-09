import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pythonQuote } from "../../src/lib/contain.js";
import { NotesError, NotesStore } from "../../src/notes/store.js";
import { loadJsonFixture, templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";

const confinement = loadJsonFixture<{
  shared_ok: string;
  rejected: Array<{ case: string; error: string }>;
}>("notes/confinement.json");

function notesStore(): NotesStore {
  const root = path.join(tempDir("guilds-notes-"), "notes");
  mkdirSync(root);
  return new NotesStore(root, templatesRoot(), "notes");
}

test("ensure_system_prompt uses the template", async () => {
  const notes = notesStore();
  await notes.ensureSystemPrompt();
  const expected = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  assert.equal(notes.systemPath(), path.resolve(path.join(templatesRoot(), "system.md")));
  const item = notes.readSystemPrompt();
  assert.equal(item.path, "system.md");
  assert.equal(item.content, expected);
  assert.ok(item.obsidian.startsWith("obsidian://open?path="));
  assert.equal(item.obsidian, `obsidian://open?path=${pythonQuote(notes.systemPath())}`);
});

test("create_guild and create_agent layout", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const guild = path.join(notes.root, "orgs", "acme", "guilds", "research");
  const agent = path.join(guild, "agents", "researcher");
  assert.ok(statSync(path.join(guild, "shared")).isDirectory());
  assert.ok(statSync(path.join(agent, "notes")).isDirectory());
  assert.ok(statSync(path.join(agent, "routines")).isDirectory());
  assert.ok(statSync(path.join(agent, "history-archive")).isDirectory());
  assert.equal(readFileSync(path.join(agent, "memory.md"), "utf8"), "");
  const files = notes.listAgentFiles("acme", "research", "researcher");
  assert.deepEqual(
    files.map((item) => item.path),
    ["task.md", "memory.md"],
  );
  const task = files.find((item) => item.path === "task.md");
  const absolute = path.resolve(path.join(agent, "task.md"));
  assert.equal(task?.obsidian, `obsidian://open?path=${pythonQuote(absolute)}`);
  assert.equal(notes.readAgentFile("acme", "research", "researcher", "task.md"), readFileSync(path.join(agent, "task.md"), "utf8"));
  assert.equal(
    notes.readAgentFile("acme", "research", "researcher", "task.md"),
    readFileSync(path.join(templatesRoot(), "task.md"), "utf8"),
  );
  assert.deepEqual(notes.listSharedFiles("acme", "research"), []);
});

test("create_agent uses task as the starting prompt", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher", "  Watch the inbox.  ");
  assert.equal(notes.readAgentFile("acme", "research", "researcher", "task.md"), "Watch the inbox.\n");
});

test("delete_agent and delete_guild remove trees", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.createGuild("acme", "ops");
  const agent = path.join(notes.root, "orgs", "acme", "guilds", "research", "agents", "researcher");
  writeFileSync(path.join(agent, "notes", "scratch.md"), "scratch");
  await notes.deleteAgent("acme", "research", "researcher");
  await notes.deleteAgent("acme", "research", "researcher");
  const guild = path.join(notes.root, "orgs", "acme", "guilds", "research");
  writeFileSync(path.join(guild, "shared", "findings.md"), "findings");
  await notes.deleteGuild("acme", "research");
  await notes.deleteGuild("acme", "research");
  assert.ok(!existsSync(guild));
  assert.ok(statSync(path.join(notes.root, "orgs", "acme", "guilds", "ops", "shared")).isDirectory());
});

test("rename_guild and rename_agent move trees", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const agent = path.join(notes.root, "orgs", "acme", "guilds", "research", "agents", "researcher");
  writeFileSync(path.join(agent, "notes", "scratch.md"), "scratch");
  await notes.renameAgent("acme", "research", "researcher", "analyst");
  const renamedAgent = path.join(notes.root, "orgs", "acme", "guilds", "research", "agents", "analyst");
  assert.ok(!existsSync(agent));
  assert.equal(readFileSync(path.join(renamedAgent, "notes", "scratch.md"), "utf8"), "scratch");
  await notes.renameGuild("acme", "research", "lab");
  const renamedGuild = path.join(notes.root, "orgs", "acme", "guilds", "lab");
  assert.ok(!existsSync(path.join(notes.root, "orgs", "acme", "guilds", "research")));
  assert.equal(
    readFileSync(path.join(renamedGuild, "agents", "analyst", "notes", "scratch.md"), "utf8"),
    "scratch",
  );
  await notes.renameGuild("acme", "missing", "elsewhere");
  await notes.renameAgent("acme", "lab", "missing", "other");
  await notes.createGuild("acme", "ops");
  await assert.rejects(
    () => notes.renameGuild("acme", "lab", "ops"),
    (error: Error) => error instanceof NotesError && error.message === "guild folder already exists: ops",
  );
  await notes.createAgent("acme", "lab", "scribe");
  await assert.rejects(
    () => notes.renameAgent("acme", "lab", "analyst", "scribe"),
    (error: Error) => error instanceof NotesError && error.message === "agent folder already exists: scribe",
  );
});

test("shared and private path confinement", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const shared = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared");
  writeFileSync(path.join(shared, "note.md"), "hello");
  mkdirSync(path.join(shared, "nested"));
  writeFileSync(path.join(shared, "nested", "deep.md"), "nested");
  const listed = notes.listSharedFiles("acme", "research");
  assert.deepEqual(
    listed.map((item) => item.path),
    ["nested/deep.md", "note.md"],
  );
  assert.equal(notes.readSharedFile("acme", "research", "note.md"), confinement.shared_ok);
  const cases: Record<string, () => void> = {
    shared_escape: () => notes.readSharedFile("acme", "research", "../agents/researcher/task.md"),
    shared_gitkeep: () => notes.readSharedFile("acme", "research", ".gitkeep"),
    agent_escape: () => notes.readAgentFile("acme", "research", "researcher", "../shared/note.md"),
    agent_nested_escape: () =>
      notes.readAgentFile("acme", "research", "researcher", "notes/../../shared/note.md"),
  };
  for (const item of confinement.rejected) {
    const run = cases[item.case];
    assert.ok(run, item.case);
    assert.throws(run, (error: Error) => error instanceof NotesError && error.message === item.error);
  }
});

test("write existing markdown files", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const privateFile = path.join(
    notes.root,
    "orgs",
    "acme",
    "guilds",
    "research",
    "agents",
    "researcher",
    "notes",
    "scratch.md",
  );
  const shared = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared", "note.md");
  writeFileSync(privateFile, "old private");
  writeFileSync(shared, "old shared");
  const taskRepo = await notes.writeAgentFile("acme", "research", "researcher", "task.md", "updated task");
  const privateRepo = await notes.writeAgentFile(
    "acme",
    "research",
    "researcher",
    "notes/scratch.md",
    "updated private",
  );
  const sharedRepo = await notes.writeSharedFile("acme", "research", "note.md", "updated shared");
  assert.equal(taskRepo, "orgs/acme/guilds/research/agents/researcher/task.md");
  assert.equal(privateRepo, "orgs/acme/guilds/research/agents/researcher/notes/scratch.md");
  assert.equal(sharedRepo, "orgs/acme/guilds/research/shared/note.md");
  assert.equal(notes.readAgentFile("acme", "research", "researcher", "task.md"), "updated task");
  assert.equal(notes.readAgentFile("acme", "research", "researcher", "notes/scratch.md"), "updated private");
  assert.equal(notes.readSharedFile("acme", "research", "note.md"), "updated shared");
});

test("operator can edit a routine note through the files pane", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.writeRoutineNote("acme", "research", "researcher", "sch_1", "Check Gmail.");
  const repo = await notes.writeAgentFile(
    "acme",
    "research",
    "researcher",
    "routines/sch_1.md",
    "Read shared notes.",
  );
  assert.equal(repo, "orgs/acme/guilds/research/agents/researcher/routines/sch_1.md");
  assert.equal(notes.readRoutineNote("acme", "research", "researcher", "sch_1"), "Read shared notes.");
  await assert.rejects(
    () => notes.writeNote("private", "acme", "research", "researcher", "routines/sch_1.md", "nope"),
    /cannot be overwritten/,
  );
});

test("write markdown creates missing notes and rejects escape", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await assert.rejects(
    () => notes.writeAgentFile("acme", "research", "researcher", "prompt.py", "print(1)"),
    /path must end in \.md/,
  );
  const created = await notes.writeAgentFile(
    "acme",
    "research",
    "researcher",
    "notes/missing.md",
    "hello",
  );
  assert.equal(created, "orgs/acme/guilds/research/agents/researcher/notes/missing.md");
  assert.equal(notes.readAgentFile("acme", "research", "researcher", "notes/missing.md"), "hello");
  await assert.rejects(
    () => notes.writeAgentFile("acme", "research", "researcher", "../shared/note.md", "nope"),
    /invalid path/,
  );
  const sharedCreated = await notes.writeSharedFile("acme", "research", "missing.md", "shared");
  assert.equal(sharedCreated, "orgs/acme/guilds/research/shared/missing.md");
  assert.equal(notes.readSharedFile("acme", "research", "missing.md"), "shared");
  await assert.rejects(
    () => notes.writeSharedFile("acme", "research", "../agents/researcher/task.md", "nope"),
    /invalid path/,
  );
});

test("delete private and shared notes prunes empty parents", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const privateFile = path.join(
    notes.root,
    "orgs",
    "acme",
    "guilds",
    "research",
    "agents",
    "researcher",
    "notes",
    "competitors",
    "acme.md",
  );
  mkdirSync(path.dirname(privateFile), { recursive: true });
  writeFileSync(privateFile, "acme");
  const sharedNested = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared", "handoff", "note.md");
  mkdirSync(path.dirname(sharedNested), { recursive: true });
  writeFileSync(sharedNested, "shared");
  await notes.deleteAgentFile("acme", "research", "researcher", "notes/competitors/acme.md");
  await notes.deleteSharedFile("acme", "research", "handoff/note.md");
  assert.deepEqual(
    notes.listAgentFiles("acme", "research", "researcher").map((item) => item.path),
    ["task.md", "memory.md"],
  );
  assert.deepEqual(notes.listSharedFiles("acme", "research"), []);
});

test("delete rejects protected agent files", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.writeMemory("acme", "research", "researcher", "keep", {
    source: "r_1",
    replacedBy: "run r_1 (direct)",
  });
  await notes.writeRoutineNote("acme", "research", "researcher", "sch_1", "Check Gmail.");
  const listed = notes.listNotes("private", "acme", "research", "researcher", "history-archive/");
  const archive = listed.find((item) => item.endsWith(".md"));
  const archiveRel = (archive ?? "").split("/agents/researcher/")[1] ?? "";
  await assert.rejects(
    () => notes.deleteAgentFile("acme", "research", "researcher", "task.md"),
    /cannot delete this file/,
  );
  await assert.rejects(
    () => notes.deleteAgentFile("acme", "research", "researcher", "memory.md"),
    /cannot delete this file/,
  );
  await assert.rejects(
    () => notes.deleteAgentFile("acme", "research", "researcher", archiveRel),
    /memory archive notes cannot be deleted/,
  );
  await assert.rejects(
    () => notes.deleteAgentFile("acme", "research", "researcher", "routines/sch_1.md"),
    /routine notes cannot be deleted/,
  );
});
