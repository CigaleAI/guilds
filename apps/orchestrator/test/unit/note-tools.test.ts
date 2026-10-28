import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActor } from "../../src/artifacts/actors.js";
import type { ArtifactActor } from "../../src/artifacts/types.js";
import { parseColumns } from "../../src/artifacts/columns.js";
import { ArtifactError } from "../../src/artifacts/errors.js";
import type { CollectionColumn } from "../../src/db/schema/index.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { noteRowAt } from "../helpers/artifacts.js";

type Stored = {
  display_path: string;
  kind: string;
  level: string;
  owner_id: string;
  key: string;
  content_text?: string;
};

type FakeCollection = { name: string; columns: CollectionColumn[]; access: "read" | "write"; count: number };

/** Enough of the store for the tool handlers: notes by display path, records by collection. */
class FakeStore {
  rows: Stored[] = [];
  collections = new Map<string, FakeCollection>();
  records = new Map<string, Array<Record<string, unknown>>>();
  calls: Array<{ method: string; args: unknown }> = [];

  declare(name: string, columns: unknown[], access: "read" | "write" = "write", count = 0): void {
    this.collections.set(name, { name, columns: parseColumns(columns), access, count });
    this.records.set(name, []);
  }

  private collection(name: string): FakeCollection {
    const known = this.collections.get(name);
    if (!known) throw new ArtifactError(`unknown collection ${name}`, 404);
    return known;
  }

  view(row: Stored) {
    return { display_path: row.display_path, content: row.content_text };
  }

  async writeNote(actor: ArtifactActor, args: { level: string; key: string; content: string }) {
    const ownerId = args.level === "agent" ? actor.agentId : args.level === "guild" ? actor.guildId : actor.orgId;
    const prefix =
      args.level === "agent"
        ? `org/${actor.orgId}/agents/${ownerId}/`
        : args.level === "guild"
          ? `org/${actor.orgId}/guilds/${ownerId}/`
          : `org/${actor.orgId}/`;
    const display = `${prefix}${args.key}`;
    const row: Stored = {
      display_path: display,
      kind: "note",
      level: args.level,
      owner_id: String(ownerId),
      key: args.key,
      content_text: args.content,
    };
    this.rows = this.rows.filter((item) => item.display_path !== display);
    this.rows.push(row);
    return { href: display, row: noteRowAt(display, args.content) };
  }

  async writeNoteAt(actor: ArtifactActor, path: string, content: string) {
    this.calls.push({ method: "writeNoteAt", args: { path, content } });
    const row = this.rows.find((item) => item.display_path === path);
    if (!row || !this.readable(actor, row)) {
      throw new ArtifactError("artifact not found", 404);
    }
    row.content_text = content;
    return noteRowAt(path, content);
  }

  async findNotes(actor: ArtifactActor) {
    const notes = this.rows.filter((row) => this.readable(actor, row) && row.kind === "note").map((row) => this.view(row));
    return { notes };
  }

  async getByDisplayPath(actor: ArtifactActor, path: string) {
    const row = this.rows.find((item) => item.display_path === path);
    if (!row || !this.readable(actor, row)) {
      throw new Error("artifact not found");
    }
    return { row: noteRowAt(row.display_path, row.content_text ?? "") };
  }

  async deleteByDisplayPath(actor: ArtifactActor, path: string) {
    const row = this.rows.find((item) => item.display_path === path);
    if (!row || !this.readable(actor, row)) {
      throw new Error("artifact not found");
    }
    this.rows = this.rows.filter((item) => item.display_path !== path);
  }

  async collectionFacts(_actor: ArtifactActor, name: string) {
    const known = this.collections.get(name);
    if (!known) return null;
    return { name, count: known.count, newest_updated_at: known.count ? "2026-09-22T05:42:10Z" : null, columns: known.columns };
  }

  async listRecords(_actor: ArtifactActor, args: Record<string, unknown>) {
    this.calls.push({ method: "listRecords", args });
    const known = this.collection(String(args.collection));
    const records = this.records.get(known.name) ?? [];
    return { total: records.length, records, columns: known.columns };
  }

  async searchRecords(_actor: ArtifactActor, args: Record<string, unknown>) {
    this.calls.push({ method: "searchRecords", args });
    return { records: [] };
  }

  async addRecord(_actor: ArtifactActor, args: { collection: string; body: Record<string, unknown> }) {
    this.calls.push({ method: "addRecord", args });
    const known = this.collection(args.collection);
    if (known.access !== "write") throw new ArtifactError(`no write access to ${known.name}`, 403);
    const list = this.records.get(known.name) ?? [];
    const record = { id: list.length + 1, collection: known.name, ...args.body, updated_at: "2026-09-22T05:42:10Z" };
    list.push(record);
    return { record, merged: args.body.email === "dup@x.io" ? 1 : null };
  }

  async updateRecord(_actor: ArtifactActor, args: { collection: string; id: unknown; body: Record<string, unknown> }) {
    this.calls.push({ method: "updateRecord", args });
    const known = this.collection(args.collection);
    const record = { id: Number(args.id), collection: known.name, ...args.body };
    return { record, warnings: args.body.status === "won" ? ['column "score": expected number; got "n/a"'] : [] };
  }

  async removeRecord(_actor: ArtifactActor, args: { collection: string; id: unknown }) {
    this.calls.push({ method: "removeRecord", args });
    this.collection(args.collection);
    return Number(args.id);
  }

  /** The default access lists: the organisation reads org notes, a guild its own, an agent its own. */
  private readable(actor: ArtifactActor, row: Stored) {
    if (row.level === "org") return true;
    if (row.level === "guild") return actor.operator || actor.guildId === row.owner_id;
    return actor.operator || actor.agentId === row.owner_id;
  }
}

function ctx(store: FakeStore, extra: { agentId?: string; guildId?: string } = {}) {
  const agentId = extra.agentId ?? "a_1";
  const guildId = extra.guildId ?? "guild_1";
  return createToolContext({
    run_id: "r_1",
    agent_id: agentId,
    guild_id: guildId,
    sandbox: null,
    secrets: {},
    artifacts: store as never,
    artifact_actor: agentActor({
      orgId: "org_1",
      guildId,
      agentId,
      agentName: "researcher",
    }),
  });
}

async function invoke(
  toolCtx: ReturnType<typeof createToolContext>,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const [payload, metadata] = await invokeTool(
    toolCtx,
    { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(arguments_) } },
    {},
    32_768,
  );
  return { content: String(payload.content), metadata };
}

const parse = (content: string) => JSON.parse(content.replace(/\nremaining_tool_calls: \d+$/, "")) as Record<string, unknown>;

const SCOUT_COLUMNS = [
  { name: "project", type: "text", description: "project name", required: true },
  { name: "handled", type: "boolean", description: "picked up by the desk", required: true },
  { name: "status", type: "text", description: "queue state", values: ["new", "done"] },
];

test("note_write stores an agent note directly under the agent", async () => {
  const store = new FakeStore();
  const toolCtx = ctx(store);
  const stored = await invoke(toolCtx, "note_write", {
    level: "agent",
    key: "acme.md",
    content: "hello\n",
  });
  assert.equal(stored.content, "org/org_1/agents/a_1/acme.md");
  assert.equal(stored.metadata.error, null);
  const found = await invoke(toolCtx, "note_find", { query: "" });
  assert.deepEqual(Object.keys(parse(found.content)), ["notes"]);
  assert.match(found.content, /agents\/a_1\/acme.md/);
  const got = await invoke(toolCtx, "note_get", { path: stored.content });
  assert.match(got.content, /hello/);
});

test("an agent cannot reach its memory archive", async () => {
  const store = new FakeStore();
  const toolCtx = ctx(store);
  const archived = "org/org_1/agents/a_1/history-archive/20260101T000000Z-r_1.md";
  assert.match((await invoke(toolCtx, "note_get", { path: archived })).content, /ERROR: unknown artifact path/);
  assert.match((await invoke(toolCtx, "note_delete", { path: archived })).content, /ERROR: unknown artifact path/);
});

test("agent cannot read another agent's private note", async () => {
  const store = new FakeStore();
  const researcher = ctx(store, { agentId: "a_1" });
  await invoke(researcher, "note_write", {
    level: "agent",
    key: "secret.md",
    content: "private",
  });
  const scout = ctx(store, { agentId: "a_2" });
  const missing = await invoke(scout, "note_get", {
    path: "org/org_1/agents/a_1/secret.md",
  });
  assert.match(missing.content, /ERROR: artifact not found/);
});

test("note_write reports the store's refusal of a level the agent cannot write", async () => {
  const store = new FakeStore();
  const toolCtx = ctx(store);
  store.writeNote = async () => {
    throw new Error("write not allowed");
  };
  const result = await invoke(toolCtx, "note_write", {
    level: "guild",
    key: "brief.md",
    content: "x",
  });
  assert.match(result.content, /write not allowed/);
});

test("note_write with a path rewrites that existing note", async () => {
  const store = new FakeStore();
  const writer = ctx(store, { agentId: "a_1", guildId: "guild_1" });
  const created = await invoke(writer, "note_write", { level: "guild", key: "brief.md", content: "v1" });
  const peer = ctx(store, { agentId: "a_2", guildId: "guild_1" });
  const rewritten = await invoke(peer, "note_write", { path: created.content, content: "v2" });
  assert.equal(rewritten.content, created.content);
  assert.deepEqual(store.calls.at(-1), { method: "writeNoteAt", args: { path: created.content, content: "v2" } });
  assert.match((await invoke(peer, "note_get", { path: created.content })).content, /v2/);
});

test("note_write needs a path or a level", async () => {
  const store = new FakeStore();
  const result = await invoke(ctx(store), "note_write", { key: "brief.md", content: "x" });
  assert.match(result.content, /level must be agent, guild, or org/);
});

test("note tools point at the record tools for collection paths", async () => {
  const store = new FakeStore();
  const toolCtx = ctx(store);
  assert.match((await invoke(toolCtx, "note_get", { path: "org/org_1/collections/scout-board/3" })).content, /record_search or record_list/);
  assert.match((await invoke(toolCtx, "note_delete", { path: "org/org_1/collections/scout-board/3" })).content, /record_remove/);
  assert.match((await invoke(toolCtx, "note_delete", { path: "org/org_1/collections/scout-board" })).content, /managed by the operator/);
});

test("record_list explains an empty narrowed result from the collection's facts", async () => {
  const store = new FakeStore();
  store.declare("scout-board", SCOUT_COLUMNS, "write", 11);
  store.declare("fresh", SCOUT_COLUMNS, "read", 0);
  const toolCtx = ctx(store);

  const byWhere = parse((await invoke(toolCtx, "record_list", { collection: "scout-board", where: { handled: false } })).content);
  assert.equal(byWhere.total, 0);
  assert.deepEqual(byWhere.records, []);
  assert.match(
    String(byWhere.hint),
    /^No records in scout-board where \{"handled":false\}\. scout-board holds 11 records; the newest changed at 2026-09-22T05:42:10Z\./,
  );
  assert.match(String(byWhere.hint), /Its columns: project \(text, required\); handled \(boolean, required\); status \(text: new \| done\)\./);
  assert.match(String(byWhere.hint), /a larger limit will not change it\. where matches by column type/);

  const bySince = parse((await invoke(toolCtx, "record_list", { collection: "fresh", since: "2026-09-22T06:13:00Z" })).content);
  assert.match(String(bySince.hint), /^No records in fresh changed at or after 2026-09-22T06:13:00Z\. fresh holds no records yet\./);
  assert.match(String(bySince.hint), /since is for picking up new work — to check whether something is already recorded, use where on the unique column or record_search/);

  // a plain listing gets no hint, an unknown collection is an error
  assert.equal("hint" in parse((await invoke(toolCtx, "record_list", { collection: "scout-board" })).content), false);
  assert.match((await invoke(toolCtx, "record_list", { collection: "other", where: { x: 1 } })).content, /ERROR: unknown collection other/);
  assert.deepEqual(store.calls[0], {
    method: "listRecords",
    args: { collection: "scout-board", where: { handled: false }, since: undefined, order: undefined, limit: undefined, offset: undefined },
  });
});

test("record_search passes the collection, query, and where through", async () => {
  const store = new FakeStore();
  store.declare("scout-board", SCOUT_COLUMNS);
  const toolCtx = ctx(store);
  const result = parse((await invoke(toolCtx, "record_search", { query: "Zebra OR AntHood", collection: "scout-board", where: { handled: false }, limit: 5 })).content);
  assert.deepEqual(result, { records: [] });
  assert.deepEqual(store.calls[0], {
    method: "searchRecords",
    args: { collection: "scout-board", query: "Zebra OR AntHood", where: { handled: false }, limit: 5 },
  });
  const everywhere = await invoke(toolCtx, "record_search", { query: "Zebra" });
  assert.match(everywhere.content, /"records":\[\]/);
  assert.deepEqual(store.calls[1]?.args, { query: "Zebra", where: undefined, limit: undefined });
});

test("record_add returns the record and names a merge", async () => {
  const store = new FakeStore();
  store.declare("scout-board", SCOUT_COLUMNS);
  const toolCtx = ctx(store);
  const added = parse((await invoke(toolCtx, "record_add", { collection: "scout-board", body: { project: "Zebra", handled: false } })).content);
  assert.deepEqual(added.record, { id: 1, collection: "scout-board", project: "Zebra", handled: false, updated_at: "2026-09-22T05:42:10Z" });
  assert.equal("note" in added, false);
  const merged = parse((await invoke(toolCtx, "record_add", { collection: "scout-board", body: { email: "dup@x.io" } })).content);
  assert.equal(merged.note, "merged into existing record 1");
  const bad = await invoke(toolCtx, "record_add", { collection: "scout-board", body: "nope" });
  assert.match(bad.content, /ERROR: body must be a JSON object of column: value/);
});

test("record_add is refused on a read-only collection", async () => {
  const store = new FakeStore();
  store.declare("scout-board", SCOUT_COLUMNS, "read");
  const toolCtx = ctx(store);
  const refused = await invoke(toolCtx, "record_add", { collection: "scout-board", body: { project: "Zebra" } });
  assert.match(refused.content, /ERROR: no write access to scout-board/);
});

test("record_update returns warnings and record_remove the removed id", async () => {
  const store = new FakeStore();
  store.declare("scout-board", SCOUT_COLUMNS);
  const toolCtx = ctx(store);
  const clean = parse((await invoke(toolCtx, "record_update", { collection: "scout-board", id: "3", body: { handled: true } })).content);
  assert.deepEqual(clean, { record: { id: 3, collection: "scout-board", handled: true } });
  const warned = parse((await invoke(toolCtx, "record_update", { collection: "scout-board", id: 4, body: { status: "won" } })).content);
  assert.deepEqual(warned.warnings, ['column "score": expected number; got "n/a"']);
  const removed = parse((await invoke(toolCtx, "record_remove", { collection: "scout-board", id: 4 })).content);
  assert.deepEqual(removed, { removed: 4 });
  assert.deepEqual(store.calls.at(-1), { method: "removeRecord", args: { collection: "scout-board", id: 4 } });
});
