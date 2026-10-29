import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_MEMORY } from "../../src/artifacts/memory.js";
import {
  MEMORY_ARCHIVE_KEEP,
  MEMORY_INTRO,
  MEMORY_INTRO_READONLY,
  MEMORY_LIMIT,
  MemoryError,
  archiveFilename,
  archiveSourceToken,
  isRelativeMemoryArchivePath,
  memoryUtcStamp,
  omitMemoryArchive,
  readMemory,
  renderMemorySection,
  validateMemory,
} from "../../src/memory/index.js";
import { NotesError, NotesStore } from "../../src/notes/store.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";

function notesStore(): NotesStore {
  const root = path.join(tempDir("guilds-memory-"), "notes");
  mkdirSync(root);
  return new NotesStore(root, templatesRoot());
}

test("readMemory returns empty when the file is missing and the file body when it exists", () => {
  const dir = tempDir("guilds-memory-read-");
  assert.equal(readMemory(dir), EMPTY_MEMORY);
  writeFileSync(path.join(dir, "memory.md"), "keep this");
  assert.equal(readMemory(dir), "keep this");
});

test("renderMemorySection wraps a writable body and drops trailing whitespace", () => {
  const section = renderMemorySection("keep this\r\n\n  ");
  assert.ok(section.startsWith("<memory>\n"));
  assert.ok(section.includes(MEMORY_INTRO));
  assert.ok(section.includes("keep this"));
  assert.ok(section.includes("memory_write"));
  assert.ok(section.endsWith("</memory>\n"));
});

test("renderMemorySection omits the body when memory is empty", () => {
  const section = renderMemorySection("");
  assert.ok(section.includes(MEMORY_INTRO));
  assert.equal(section.includes("\n\n</memory>"), false);
});

test("readonly memory section omits memory_write", () => {
  const section = renderMemorySection("keep this", false);
  assert.ok(section.includes(MEMORY_INTRO_READONLY));
  assert.ok(section.includes("keep this"));
  assert.ok(!section.includes("memory_write"));
});

test("memoryUtcStamp replaces colons so the name is a file token", () => {
  const now = new Date("2026-09-13T09:00:12.000Z");
  assert.equal(memoryUtcStamp(now), "2026-09-13T09-00-12Z");
  assert.equal(archiveFilename(now, "r_ab12cd"), "2026-09-13T09-00-12Z-r_ab12cd.md");
});

test("archiveSourceToken sanitizes slashes and colons and rejects empty or dot names", () => {
  assert.equal(archiveSourceToken("run/r:1"), "run-r-1");
  assert.throws(() => archiveSourceToken(""), MemoryError);
  assert.throws(() => archiveSourceToken("."), MemoryError);
  assert.throws(() => archiveSourceToken(".."), MemoryError);
  assert.throws(() => archiveSourceToken("  "), MemoryError);
});

test("omitMemoryArchive drops archive trees and keeps other notes", () => {
  const paths = [
    "orgs/acme/guilds/research/agents/researcher/notes/alpha.md",
    "orgs/acme/guilds/research/agents/researcher/notes/history-archive/",
    "orgs/acme/guilds/research/agents/researcher/notes/history-archive/2026-09-13T09-00-12Z-r_ab12cd.md",
    "orgs/acme/guilds/research/agents/researcher/notes/memory-archive/",
    "orgs/acme/guilds/research/agents/researcher/notes/memory-archive/2026-09-13T09-00-12Z-r_ab12cd.md",
    "orgs/acme/guilds/research/agents/researcher/history-archive/",
    "orgs/acme/guilds/research/agents/researcher/history-archive/2026-09-13T09-00-12Z-r_ab12cd.md",
  ];
  assert.deepEqual(omitMemoryArchive(paths), [
    "orgs/acme/guilds/research/agents/researcher/notes/alpha.md",
  ]);
});

test("isRelativeMemoryArchivePath matches archive dirs and notes/ children only", () => {
  assert.equal(isRelativeMemoryArchivePath("history-archive"), true);
  assert.equal(isRelativeMemoryArchivePath("history-archive/old.md"), true);
  assert.equal(isRelativeMemoryArchivePath("notes/memory-archive/old.md"), true);
  assert.equal(isRelativeMemoryArchivePath("notes/alpha.md"), false);
});

test("validateMemory allows a body at the cap and rejects one over it", () => {
  validateMemory("x".repeat(MEMORY_LIMIT));
  assert.throws(
    () => validateMemory("x".repeat(MEMORY_LIMIT + 1)),
    (error: Error) => error instanceof MemoryError && error.message === `memory exceeds ${MEMORY_LIMIT} characters`,
  );
});

test("create_agent writes empty memory", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const filePath = path.join(
    notes.root,
    "orgs",
    "acme",
    "guilds",
    "research",
    "agents",
    "researcher",
    "memory.md",
  );
  assert.equal(readFileSync(filePath, "utf8"), EMPTY_MEMORY);
  assert.equal(readFileSync(path.join(templatesRoot(), "memory.md"), "utf8"), EMPTY_MEMORY);
  assert.deepEqual(
    notes.listAgentFiles("acme", "research", "researcher").map((item) => item.path),
    ["task.md", "memory.md"],
  );
});

test("ensure_memory_files creates missing and lifts a legacy archive", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const agent = path.join(notes.root, "orgs", "acme", "guilds", "research", "agents", "researcher");
  const memoryPath = path.join(agent, "memory.md");
  unlinkSync(memoryPath);
  const legacy = path.join(agent, "notes", "memory-archive");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "2026-09-13T09-00-12Z-r_ab12cd.md"), "old memory");
  await notes.ensureMemoryFiles();
  assert.equal(readFileSync(memoryPath, "utf8"), EMPTY_MEMORY);
  assert.equal(
    readFileSync(path.join(agent, "history-archive", "2026-09-13T09-00-12Z-r_ab12cd.md"), "utf8"),
    "old memory",
  );
});

test("write_memory archives and is a noop when unchanged", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const first = await notes.writeMemory(
    "acme",
    "research",
    "researcher",
    "inbox\nread mail\nmornings are quiet",
    { source: "r_ab12cd", replacedBy: 'run r_ab12cd (schedule wake-up: "check inbox")' },
  );
  assert.ok(first.startsWith("memory.md written; previous archived as history-archive/"));
  const agent = path.join(notes.root, "orgs", "acme", "guilds", "research", "agents", "researcher");
  assert.equal(readFileSync(path.join(agent, "memory.md"), "utf8"), "inbox\nread mail\nmornings are quiet");
  const archives = notes
    .listPrivateNotes("acme", "research", "researcher", "history-archive/")
    .filter((item) => item.endsWith(".md"));
  assert.equal(archives.length, 1);
  const stored = notes.readPrivateNote("acme", "research", "researcher", archives[0] ?? "")[1];
  assert.ok(stored.startsWith("Current: "));
  assert.ok(stored.includes('Replaced by: run r_ab12cd (schedule wake-up: "check inbox")'));
  const again = await notes.writeMemory(
    "acme",
    "research",
    "researcher",
    "inbox\nread mail\nmornings are quiet",
    { source: "r_ab12cd", replacedBy: 'run r_ab12cd (schedule wake-up: "check inbox")' },
  );
  assert.equal(again, "memory.md unchanged");
  assert.equal(
    notes
      .listPrivateNotes("acme", "research", "researcher", "history-archive/")
      .filter((item) => item.endsWith(".md")).length,
    1,
  );
});

test("note_write refuses the memory archive", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  await notes.writeMemory("acme", "research", "researcher", "a\nb\nc", {
    source: "r_1",
    replacedBy: "run r_1 (direct)",
  });
  const listed = notes.listPrivateNotes("acme", "research", "researcher", "history-archive/");
  const archive = listed.find((item) => item.endsWith(".md"));
  assert.ok(archive);
  await assert.rejects(
    () => notes.writePrivateNote("acme", "research", "researcher", archive ?? "", "nope"),
    (error: Error) =>
      error instanceof NotesError && error.message.includes("memory archive notes cannot be overwritten"),
  );
  const relative = (archive ?? "").split("/agents/researcher/")[1] ?? "";
  await assert.rejects(
    () => notes.writeAgentFile("acme", "research", "researcher", relative, "nope", { actor: "manu" }),
    /memory archive notes cannot be overwritten/,
  );
});

test("files pane save archives with the user", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const result = await notes.writeAgentFile(
    "acme",
    "research",
    "researcher",
    "memory.md",
    "keep the inbox clean",
    { actor: "manu" },
  );
  assert.ok(result.startsWith("memory.md written; previous archived as history-archive/"));
  const listed = notes
    .listPrivateNotes("acme", "research", "researcher", "history-archive/")
    .filter((item) => item.endsWith(".md"));
  assert.ok(listed.some((item) => item.includes("-manu.md")));
  const stored = notes.readPrivateNote("acme", "research", "researcher", listed[0] ?? "")[1];
  assert.ok(stored.includes("Replaced by: user manu (Files pane)"));
});

test("memory archive keeps the newest fifty", async () => {
  const notes = notesStore();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  for (let index = 0; index < MEMORY_ARCHIVE_KEEP + 3; index += 1) {
    await notes.writeMemory("acme", "research", "researcher", `goal ${index}`, {
      source: `r_${String(index).padStart(2, "0")}`,
      replacedBy: `run r_${String(index).padStart(2, "0")} (direct)`,
    });
  }
  const listed = notes
    .listPrivateNotes("acme", "research", "researcher", "history-archive/")
    .filter((item) => item.endsWith(".md"));
  assert.equal(listed.length, MEMORY_ARCHIVE_KEEP);
});
