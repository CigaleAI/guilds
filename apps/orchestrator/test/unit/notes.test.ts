import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pythonQuote } from "../../src/lib/contain.js";
import { NotesError } from "../../src/notes/errors.js";
import { NotesStore } from "../../src/notes/store.js";
import { loadJsonFixture, templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";

const confinement = loadJsonFixture<{
  shared_ok: string;
  rejected: Array<{ case: string; error: string }>;
}>("notes/confinement.json");

function notesStore(): NotesStore {
  const root = path.join(tempDir("guilds-notes-"), "notes");
  mkdirSync(root);
  return new NotesStore(root, templatesRoot());
}

test("ensure_system_prompt uses the template", async () => {
  const notes = notesStore();
  await notes.ensureSystemPrompt();
  const expected = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  assert.equal(notes.systemPath(), path.resolve(path.join(templatesRoot(), "system.md")));
  assert.equal(readFileSync(notes.systemPath(), "utf8"), expected);
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
  const files = notes.listAgentNotesFiles("acme", "research", "researcher");
  assert.deepEqual(
    files.map((item) => item.path),
    ["task.md", "memory.md"],
  );
  const task = files.find((item) => item.path === "task.md");
  const absolute = path.resolve(path.join(agent, "task.md"));
  assert.equal(task?.obsidian, `obsidian://open?path=${pythonQuote(absolute)}`);
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "task.md"), readFileSync(path.join(agent, "task.md"), "utf8"));
  assert.equal(
    notes.readAgentNotesFile("acme", "research", "researcher", "task.md"),
    readFileSync(path.join(templatesRoot(), "task.md"), "utf8"),
  );
  assert.deepEqual(notes.listSharedNotesFiles("acme", "research"), []);
});

test("create_agent uses task as the starting prompt", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher", "  Watch the inbox.  ");
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "task.md"), "Watch the inbox.\n");
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
  const listed = notes.listSharedNotesFiles("acme", "research");
  assert.deepEqual(
    listed.map((item) => item.path),
    ["nested/deep.md", "note.md"],
  );
  assert.equal(notes.readSharedNotesFile("acme", "research", "note.md"), confinement.shared_ok);
  const cases: Record<string, () => void> = {
    shared_escape: () => notes.readSharedNotesFile("acme", "research", "../agents/researcher/task.md"),
    shared_gitkeep: () => notes.readSharedNotesFile("acme", "research", ".gitkeep"),
    agent_escape: () => notes.readAgentNotesFile("acme", "research", "researcher", "../shared/note.md"),
    agent_nested_escape: () =>
      notes.readAgentNotesFile("acme", "research", "researcher", "notes/../../shared/note.md"),
  };
  for (const item of confinement.rejected) {
    const run = cases[item.case];
    assert.ok(run, item.case);
    assert.throws(run, (error: Error) => error instanceof NotesError && error.message === item.error);
  }
});

test("list private and shared notes under a prefix", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const shared = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared");
  mkdirSync(path.join(shared, "nested"));
  writeFileSync(path.join(shared, "nested", "deep.md"), "nested");
  assert.deepEqual(notes.listSharedNotes("acme", "research", "nested/"), [
    "orgs/acme/guilds/research/shared/nested/deep.md",
  ]);
  assert.deepEqual(notes.listSharedNotes("acme", "research", "nested/deep.md"), [
    "orgs/acme/guilds/research/shared/nested/deep.md",
  ]);
  assert.throws(() => notes.listSharedNotes("acme", "research", "../agents/"), /invalid path/);
  await notes.writePrivateNote("acme", "research", "researcher", "ideas/first.md", "idea");
  writeFileSync(path.join(notes.agentDir("acme", "research", "researcher"), "routines", "sch_1.md"), "Check Gmail.");
  const root = notes.listPrivateNotes("acme", "research", "researcher", "");
  assert.ok(root.includes("orgs/acme/guilds/research/agents/researcher/notes/ideas/first.md"));
  assert.ok(root.includes("orgs/acme/guilds/research/agents/researcher/routines/sch_1.md"));
  assert.deepEqual(notes.listPrivateNotes("acme", "research", "researcher", "ideas"), [
    "orgs/acme/guilds/research/agents/researcher/notes/ideas/first.md",
  ]);
  assert.equal(notes.readPrivateNote("acme", "research", "researcher", "ideas/first.md")[1], "idea");
  assert.throws(() => notes.readPrivateNote("acme", "research", "researcher", "ideas/first.txt"), /path must end in .md/);
  assert.throws(() => notes.listPrivateNotes("acme", "research", "researcher", "../../../shared"), /invalid path/);
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
  const taskRepo = await notes.writeAgentNotesFile("acme", "research", "researcher", "task.md", "updated task", null);
  const privateRepo = await notes.writeAgentNotesFile(
    "acme",
    "research",
    "researcher",
    "notes/scratch.md",
    "updated private",
    null,
  );
  const sharedRepo = await notes.writeSharedNotesFile("acme", "research", "note.md", "updated shared");
  assert.equal(taskRepo, "orgs/acme/guilds/research/agents/researcher/task.md");
  assert.equal(privateRepo, "orgs/acme/guilds/research/agents/researcher/notes/scratch.md");
  assert.equal(sharedRepo, "orgs/acme/guilds/research/shared/note.md");
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "task.md"), "updated task");
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "notes/scratch.md"), "updated private");
  assert.equal(notes.readSharedNotesFile("acme", "research", "note.md"), "updated shared");
});

test("operator can edit a routine note through the files pane", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  writeFileSync(path.join(notes.agentDir("acme", "research", "researcher"), "routines", "sch_1.md"), "Check Gmail.");
  const repo = await notes.writeAgentNotesFile(
    "acme",
    "research",
    "researcher",
    "routines/sch_1.md",
    "Read shared notes.",
    null,
  );
  assert.equal(repo, "orgs/acme/guilds/research/agents/researcher/routines/sch_1.md");
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "routines/sch_1.md"), "Read shared notes.");
  await assert.rejects(
    () => notes.writePrivateNote("acme", "research", "researcher", "routines/sch_1.md", "nope"),
    /cannot be overwritten/,
  );
});

test("write markdown creates missing notes and rejects escape", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await assert.rejects(
    () => notes.writeAgentNotesFile("acme", "research", "researcher", "prompt.py", "print(1)", null),
    /path must end in \.md/,
  );
  const created = await notes.writeAgentNotesFile(
    "acme",
    "research",
    "researcher",
    "notes/missing.md",
    "hello",
    null,
  );
  assert.equal(created, "orgs/acme/guilds/research/agents/researcher/notes/missing.md");
  assert.equal(notes.readAgentNotesFile("acme", "research", "researcher", "notes/missing.md"), "hello");
  await assert.rejects(
    () => notes.writeAgentNotesFile("acme", "research", "researcher", "../shared/note.md", "nope", null),
    /invalid path/,
  );
  rmSync(path.join(notes.agentDir("acme", "research", "researcher"), "task.md"));
  for (const relative of ["task.md", "routines/missing.md", "notes/routines/missing.md"]) {
    await assert.rejects(
      () => notes.writeAgentNotesFile("acme", "research", "researcher", relative, "nope", null),
      /file not found/,
      relative,
    );
  }
  const sharedCreated = await notes.writeSharedNotesFile("acme", "research", "missing.md", "shared");
  assert.equal(sharedCreated, "orgs/acme/guilds/research/shared/missing.md");
  assert.equal(notes.readSharedNotesFile("acme", "research", "missing.md"), "shared");
  await assert.rejects(
    () => notes.writeSharedNotesFile("acme", "research", "../agents/researcher/task.md", "nope"),
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
  await notes.deleteAgentNotesFile("acme", "research", "researcher", "notes/competitors/acme.md");
  await notes.deleteSharedNotesFile("acme", "research", "handoff/note.md");
  assert.deepEqual(
    notes.listAgentNotesFiles("acme", "research", "researcher").map((item) => item.path),
    ["task.md", "memory.md"],
  );
  assert.deepEqual(notes.listSharedNotesFiles("acme", "research"), []);
});

test("delete rejects protected agent files", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.writeMemory("acme", "research", "researcher", "keep", {
    source: "r_1",
    replacedBy: "run r_1 (direct)",
  });
  writeFileSync(path.join(notes.agentDir("acme", "research", "researcher"), "routines", "sch_1.md"), "Check Gmail.");
  const listed = notes.listPrivateNotes("acme", "research", "researcher", "history-archive/");
  const archive = listed.find((item) => item.endsWith(".md"));
  const archiveRel = (archive ?? "").split("/agents/researcher/")[1] ?? "";
  await assert.rejects(
    () => notes.deleteAgentNotesFile("acme", "research", "researcher", "task.md"),
    /cannot delete this file/,
  );
  await assert.rejects(
    () => notes.deleteAgentNotesFile("acme", "research", "researcher", "memory.md"),
    /cannot delete this file/,
  );
  await assert.rejects(
    () => notes.deleteAgentNotesFile("acme", "research", "researcher", archiveRel),
    /memory archive notes cannot be deleted/,
  );
  await assert.rejects(
    () => notes.deleteAgentNotesFile("acme", "research", "researcher", "routines/sch_1.md"),
    /routine notes cannot be deleted/,
  );
});

test("resolve_wikilink finds a note by its path or its name in the agent's private notes, then its guild's shared notes", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.createAgent("acme", "research", "analyst");
  const agentNotes = path.join(notes.agentDir("acme", "research", "researcher"), "notes");
  const shared = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared");
  for (const file of [
    path.join(agentNotes, "ideas", "first.md"),
    path.join(agentNotes, "both.md"),
    path.join(agentNotes, "one", "same.md"),
    path.join(agentNotes, "two", "same.md"),
    path.join(shared, "handoff.md"),
    path.join(shared, "both.md"),
    path.join(shared, "one", "twice.md"),
    path.join(shared, "two", "twice.md"),
    path.join(notes.agentDir("acme", "research", "analyst"), "notes", "secret.md"),
  ]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "note");
  }
  const resolve = (target: string) => notes.resolveWikilink("acme", "research", "researcher", target);
  const first = "orgs/acme/guilds/research/agents/researcher/notes/ideas/first";
  const handoff = "orgs/acme/guilds/research/shared/handoff";
  assert.equal(resolve("first"), first);
  assert.equal(resolve(" first.md "), first);
  assert.equal(resolve(first), first);
  assert.equal(resolve("orgs\\acme\\guilds\\research\\shared\\handoff.md"), handoff);
  assert.equal(resolve("guilds/research/shared/handoff"), handoff);
  assert.equal(resolve("handoff"), handoff);
  assert.equal(resolve("both"), "orgs/acme/guilds/research/agents/researcher/notes/both");
  assert.equal(notes.resolveWikilink("acme", "research", "nobody", "handoff"), handoff);
  for (const target of ["same", "twice", "missing", "ideas/missing", "orgs/acme/guilds/research/agents/analyst/notes/secret"]) {
    assert.equal(resolve(target), null, target);
  }
  for (const target of ["", ".md", "/etc/passwd", "ideas/../first", "./first", "ideas//first"]) {
    assert.equal(resolve(target), null, target);
  }
});

test("list notes at a note, a file that is not one, a missing folder, and the private root", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const agent = notes.agentDir("acme", "research", "researcher");
  const shared = path.join(notes.root, "orgs", "acme", "guilds", "research", "shared");
  writeFileSync(path.join(agent, "notes", "first.md"), "first");
  writeFileSync(path.join(agent, "notes", "data.csv"), "a,b");
  writeFileSync(path.join(shared, "data.csv"), "a,b");
  writeFileSync(path.join(agent, "routines", "sch_1.md"), "Check Gmail.");
  assert.deepEqual(notes.listPrivateNotes("acme", "research", "researcher", "first.md"), [
    "orgs/acme/guilds/research/agents/researcher/notes/first.md",
  ]);
  assert.throws(() => notes.listPrivateNotes("acme", "research", "researcher", "data.csv"), /invalid path/);
  assert.throws(() => notes.listSharedNotes("acme", "research", "data.csv"), /invalid path/);
  assert.deepEqual(notes.listPrivateNotes("acme", "research", "researcher", "missing/"), []);
  assert.deepEqual(notes.listSharedNotes("acme", "research", "missing/"), []);
  assert.deepEqual(notes.listPrivateNotes("acme", "research", "researcher", ""), [
    "orgs/acme/guilds/research/agents/researcher/notes/first.md",
    "orgs/acme/guilds/research/agents/researcher/routines/",
    "orgs/acme/guilds/research/agents/researcher/routines/sch_1.md",
  ]);
});

test("list agent notes files lists its Task, Memory and the files under its folders, without .gitkeep", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const agent = notes.agentDir("acme", "research", "researcher");
  rmSync(path.join(agent, "task.md"));
  mkdirSync(path.join(agent, "notes", "ideas"));
  writeFileSync(path.join(agent, "notes", "ideas", "first.md"), "first");
  writeFileSync(path.join(agent, "notes", "data.csv"), "a,b");
  writeFileSync(path.join(agent, "notes", ".gitkeep"), "");
  writeFileSync(path.join(agent, "routines", "sch_1.md"), "Check Gmail.");
  rmSync(path.join(agent, "history-archive"), { recursive: true });
  assert.deepEqual(
    notes.listAgentNotesFiles("acme", "research", "researcher").map((item) => item.path),
    ["memory.md", "notes/data.csv", "notes/ideas/first.md", "routines/sch_1.md"],
  );
});
