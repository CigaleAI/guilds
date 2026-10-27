import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyRecipe } from "../../src/recipes/minimal.js";
import {
  applyAccessEdit,
  applyAccessEdits,
  applyReview,
  builderAuthor,
  formatAccessCutsMessage,
  hasForbiddenSecrets,
  operatorAccessCuts,
  operatorAuthor,
  parseRecipe,
  resetReview,
  stampBuilderWrite,
  unreviewedFields,
} from "../../src/recipes/schema.js";
import { applyBlockingErrors, blockingErrors, validateRecipe } from "../../src/recipes/validate.js";
import {
  cryptoThreeRoleRecipe,
  fixtureDeskRecipe,
  fixtureHuskDeskRecipe,
  huskLeadMatcherRecipe,
  inboxQueueColumns,
  linkedInNotionRecipe,
} from "../helpers/recipe-docs.js";
import { prepareRecipeForApply } from "../../src/recipes/prepare.js";
import { RECIPE_VERSION } from "../../src/recipes/schema.js";

const ctx = {
  publishedServers: new Set(["notion"]),
  remainingAgents: 20,
  remainingBrowserAgents: 5,
  remainingCodingAgents: 5,
  groupLimit: 20,
};

function rawCollections(recipe: unknown): Array<Record<string, unknown>> {
  return (recipe as { collections: Array<Record<string, unknown>> }).collections;
}

test("recipe collections carry typed columns, a guild mode, and writers", () => {
  const recipe = parseRecipe(fixtureHuskDeskRecipe());
  assert.equal(recipe.version, RECIPE_VERSION);
  assert.deepEqual(recipe.collections[0]?.columns, inboxQueueColumns());
  assert.equal(recipe.collections[0]?.guild, "write");
  assert.deepEqual(recipe.collections[0]?.writers, []);

  const desk = parseRecipe(fixtureDeskRecipe());
  assert.deepEqual(desk.collections.find((item) => item.name === "seen-ids")?.writers, ["reader"]);
  assert.equal(desk.collections.find((item) => item.name === "seen-ids")?.guild, "read");

  const defaults = fixtureHuskDeskRecipe();
  const first = rawCollections(defaults)[0]!;
  delete first.guild;
  delete first.writers;
  delete first.columns;
  const parsed = parseRecipe(defaults).collections[0]!;
  assert.equal(parsed.scope, "org");
  assert.equal(parsed.guild, "read");
  assert.deepEqual(parsed.writers, []);
  assert.deepEqual(parsed.columns, []);
});

test("a guild-scoped recipe collection belongs to the applied guild and takes no grants", () => {
  const owned = fixtureHuskDeskRecipe();
  const first = rawCollections(owned)[0]!;
  first.scope = "guild";
  delete first.guild;
  delete first.writers;
  const parsed = parseRecipe(owned).collections[0]!;
  assert.equal(parsed.scope, "guild");
  assert.equal(parsed.guild, "write");
  assert.deepEqual(parsed.writers, []);

  const shared = fixtureHuskDeskRecipe();
  const readOnly = rawCollections(shared)[0]!;
  readOnly.scope = "guild";
  readOnly.guild = "read";
  assert.throws(() => parseRecipe(shared), /collections\[0\]\.guild must be write when scope is guild/);

  const withWriters = fixtureHuskDeskRecipe();
  const owning = rawCollections(withWriters)[0]!;
  owning.scope = "guild";
  owning.guild = "write";
  owning.writers = ["reader"];
  assert.throws(() => parseRecipe(withWriters), /collections\[0\]\.writers is empty when scope is guild/);

  const badScope = fixtureHuskDeskRecipe();
  rawCollections(badScope)[0]!.scope = "everyone";
  assert.throws(() => parseRecipe(badScope), /collections\[0\]\.scope must be guild or org/);
});

test("recipe collections report column problems per collection and reject old shapes", () => {
  const badColumn = fixtureHuskDeskRecipe();
  badColumn.collections[0]!.columns = [
    { name: "status", type: "number", description: "state", required: true, unique: false, values: ["a"] },
  ];
  assert.throws(() => parseRecipe(badColumn), /collections\[0\]\.columns: column "status": values needs a text or array column/);

  const reserved = fixtureHuskDeskRecipe();
  reserved.collections[0]!.columns = [{ name: "id", type: "text", description: "x", required: false, unique: false }];
  assert.throws(() => parseRecipe(reserved), /collections\[0\]\.columns: column "id": name is reserved/);

  const badPod = fixtureHuskDeskRecipe();
  rawCollections(badPod)[0]!.guild = "owner";
  assert.throws(() => parseRecipe(badPod), /collections\[0\]\.guild must be read or write/);

  const badName = fixtureHuskDeskRecipe();
  badName.collections[0]!.name = "Inbox Queue";
  assert.throws(() => parseRecipe(badName), /collections\[0\]\.name must match/);

  const noPurpose = fixtureHuskDeskRecipe();
  noPurpose.collections[0]!.purpose = " ";
  assert.throws(() => parseRecipe(noPurpose), /collections\[0\]\.purpose is required/);

  const duplicate = fixtureDeskRecipe();
  duplicate.collections[1]!.name = duplicate.collections[0]!.name;
  assert.throws(() => parseRecipe(duplicate), /duplicate collection seen-ids/);

  const legacy = fixtureHuskDeskRecipe();
  rawCollections(legacy)[0]!.schema = { type: "object" };
  assert.throws(() => parseRecipe(legacy), /unknown key collections\[0\]\.schema; use `columns`/);
  const level = fixtureHuskDeskRecipe();
  rawCollections(level)[0]!.level = "guild";
  assert.throws(() => parseRecipe(level), /unknown key collections\[0\]\.level; a collection is a table of the applied guild/);
});

test("recipe format 1 is rejected", () => {
  const recipe = fixtureDeskRecipe() as unknown as Record<string, unknown>;
  recipe.version = 1;
  assert.throws(() => parseRecipe(recipe), /unsupported recipe version 1; this build reads guilds\.recipe version 2/);
  recipe.version = 3;
  assert.throws(() => parseRecipe(recipe), /unsupported recipe version 3/);
});

test("writers must be roles of the recipe", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  recipe.collections[0]!.writers = ["reader", "archivist"];
  const findings = validateRecipe(recipe, { ...ctx, publishedServers: new Set(["mail", "crm"]) });
  const writer = findings.find((item) => item.code === "collection.writer");
  assert.ok(writer);
  assert.equal(writer.severity, "error");
  assert.equal(writer.path, "collections.seen-ids");
  assert.match(writer.message, /archivist/);
});

function withNote(note: Record<string, unknown>): unknown {
  const recipe = fixtureDeskRecipe() as unknown as Record<string, unknown>;
  recipe.notes = [{ id: "n", key: "n.md", body: "Body.", kind: "seed", ...note }];
  return recipe;
}

test("a note's guild mode defaults to what its level gives and its writers to none", () => {
  const modes = (["org", "guild", "agent"] as const).map((level) => {
    const note = parseRecipe(withNote({ level, role: level === "agent" ? "reader" : undefined })).notes[0]!;
    return [level, note.guild ?? null, note.writers];
  });
  assert.deepEqual(modes, [
    ["org", "read", []],
    ["guild", "write", []],
    ["agent", null, []],
  ]);
});

test("a note carries a guild mode and writers beyond its level's rows", () => {
  const note = parseRecipe(withNote({ level: "agent", role: "writer", guild: "read", writers: ["reader", " reader "] })).notes[0]!;
  assert.equal(note.guild, "read");
  assert.deepEqual(note.writers, ["reader"]);
  assert.equal(parseRecipe(withNote({ level: "org", guild: "write" })).notes[0]?.guild, "write");
});

test("a note's guild mode is read or write and a guild note keeps guild write without writers", () => {
  assert.throws(() => parseRecipe(withNote({ level: "org", guild: "none" })), /notes\[0\]\.guild must be read or write/);
  assert.throws(() => parseRecipe(withNote({ level: "org", writers: "reader" })), /notes\[0\]\.writers must be an array/);
  assert.throws(() => parseRecipe(withNote({ level: "guild", guild: "read" })), /notes\[0\] takes guild write and no writers/);
  assert.throws(() => parseRecipe(withNote({ level: "guild", writers: ["reader"] })), /notes\[0\] takes guild write and no writers/);
});

test("a note's writers must be roles of the recipe", () => {
  const recipe = parseRecipe(withNote({ level: "org", writers: ["archivist"] }));
  const findings = validateRecipe(recipe, { ...ctx, publishedServers: new Set(["mail", "crm"]) });
  const writer = findings.find((item) => item.code === "note.writer");
  assert.ok(writer);
  assert.equal(writer.severity, "error");
  assert.equal(writer.path, "notes.n");
  assert.match(writer.message, /archivist/);
});

test("plain-text note paths must name a recipe note", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  recipe.notes = [
    { id: "rules", level: "guild", key: "rules.md", body: "Rules.\n", kind: "seed", author: operatorAuthor(), writers: [] },
  ];
  recipe.roles[0]!.task.body += "\n\nRead guild/rules.md, then note_get agent/reader/playbook.md.";
  const findings = validateRecipe(recipe, { ...ctx, publishedServers: new Set(["mail", "crm"]) });
  const unknown = findings.filter((item) => item.code === "task.note_path");
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.severity, "error");
  assert.equal(unknown[0]?.path, "roles.reader.task");
  assert.match(unknown[0]?.message ?? "", /agent\/reader\/playbook\.md/);
});

test("recipe schema rejects unknown keys and duplicate routine keys", () => {
  const base = emptyRecipe({ source: { kind: "file" } });
  assert.throws(() => parseRecipe({ ...base, extra: true }), /unknown key/);
  const alias = linkedInNotionRecipe();
  const aliasTask = alias.roles[0]?.task;
  assert.ok(aliasTask);
  (aliasTask as Record<string, unknown>).authored_by = "operator";
  assert.throws(() => parseRecipe(alias), /unknown key/);
  const linkedin = linkedInNotionRecipe();
  linkedin.roles[1]?.schedules.push({
    key: "watch-feed",
    cron: "*/30 * * * *",
    description: "dup",
    instruction: "dup",
    author: builderAuthor(),
  });
  assert.throws(() => parseRecipe(linkedin), /duplicate routine key/);
});

test("recipe roles carry optional, capped wake triggers", () => {
  const recipe = linkedInNotionRecipe();
  const omitted = { ...recipe, roles: recipe.roles.map(({ wake_triggers: _omit, ...role }) => role) };
  assert.equal(parseRecipe(omitted).roles[0]?.wake_triggers, "");
  const set = linkedInNotionRecipe();
  set.roles[0]!.wake_triggers = "  a post needs a reply  ";
  assert.equal(parseRecipe(set).roles[0]?.wake_triggers, "a post needs a reply");
  set.roles[0]!.wake_triggers = "x".repeat(501);
  assert.throws(() => parseRecipe(set), /roles\[0\]\.wake_triggers must be at most 500/);
});

test("recipe schedules take a cron or a random window", () => {
  const windowed = linkedInNotionRecipe();
  const schedule = windowed.roles[0]?.schedules[0] as Record<string, unknown> | undefined;
  assert.ok(schedule);
  delete schedule.cron;
  schedule.window = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 12 };
  const parsed = parseRecipe(windowed);
  assert.deepEqual(parsed.roles[0]?.schedules[0]?.window, schedule.window);
  assert.equal(parsed.roles[0]?.schedules[0]?.cron, undefined);
  assert.equal(blockingErrors(validateRecipe(parsed, ctx)).length, 0);

  const crowded = parseRecipe(windowed);
  crowded.roles[0]!.schedules[0]!.window!.max_wakes = 500;
  assert.ok(validateRecipe(crowded, ctx).some((item) => item.code === "schedule.invalid" && /at most 144/.test(item.message)));

  const empty = parseRecipe(windowed);
  delete empty.roles[0]!.schedules[0]!.window;
  assert.ok(validateRecipe(empty, ctx).some((item) => item.code === "schedule.invalid" && /exactly one/.test(item.message)));

  schedule.window = { timezone: "UTC", start: "08:00", end: "20:00", max_wakes: 12, jitter: 1 };
  assert.throws(() => parseRecipe(windowed), /unknown key/);
});

test("unreviewed builder fields and import reset", () => {
  const recipe = parseRecipe(linkedInNotionRecipe(builderAuthor()));
  const fields = unreviewedFields(recipe);
  assert.ok(fields.includes("roles.watcher.task"));
  const imported = parseRecipe(linkedInNotionRecipe());
  for (const role of imported.roles) {
    role.task.author = resetReview(role.task.author);
    role.browser.author = resetReview(role.browser.author);
  }
  assert.ok(unreviewedFields(imported).includes("roles.watcher.task"));
  assert.equal(hasForbiddenSecrets({ ciphertext: "nope" }), true);
});

test("LinkedIn and crypto fixtures are structurally valid without per-field confirm", () => {
  const linkedin = parseRecipe(linkedInNotionRecipe());
  const crypto = parseRecipe(cryptoThreeRoleRecipe());
  assert.equal(blockingErrors(validateRecipe(linkedin, ctx)).length, 0);
  assert.equal(blockingErrors(validateRecipe(crypto, ctx)).length, 0);
  const unreadied = parseRecipe(linkedInNotionRecipe(builderAuthor()));
  assert.equal(blockingErrors(validateRecipe(unreadied, ctx)).length, 0);
  assert.ok(unreviewedFields(unreadied).includes("roles.watcher.task"));
});

test("capacity and unknown server are mechanical errors", () => {
  const recipe = parseRecipe(linkedInNotionRecipe());
  const capacity = validateRecipe(recipe, { ...ctx, remainingAgents: 1 });
  assert.ok(capacity.some((item) => item.code === "capacity.agents" && item.severity === "error"));
  const unknown = validateRecipe(recipe, { ...ctx, publishedServers: new Set() });
  assert.ok(unknown.some((item) => item.code === "server.unknown"));
});

test("empty task is derived when focus exists, and unreviewed fields do not block apply", () => {
  const husk = parseRecipe(huskLeadMatcherRecipe(builderAuthor()));
  const findings = validateRecipe(husk, { ...ctx, publishedServers: new Set(["notion", "cigale"]) });
  assert.ok(findings.some((item) => item.code === "task.derived"));
  assert.ok(findings.some((item) => item.code === "schedule.missing"));
  assert.ok(findings.some((item) => item.code === "connection.missing"));
  assert.equal(findings.some((item) => item.code === "schedule.inferred"), false);
  assert.equal(findings.some((item) => item.code === "connection.inferred"), false);
  assert.equal(findings.some((item) => item.code === "review.required"), false);
  assert.equal(applyBlockingErrors(findings).some((item) => item.code === "review.required"), false);
  assert.ok(unreviewedFields(husk).some((path) => path.endsWith(".task")));
  assert.equal(husk.roles[0]?.task.body, "");
});

test("apply fills an empty task and does not invent wakes or connectors", () => {
  const prepared = prepareRecipeForApply(parseRecipe(huskLeadMatcherRecipe()));
  const role = prepared.roles[0];
  assert.ok(role);
  assert.match(role.task.body, /Match Cigale stories/);
  assert.match(role.task.body, /Every 15 minutes/);
  assert.equal(role.schedules.length, 0);
  assert.deepEqual(prepared.connections, []);
});

test("apply does not infer a wake from prose cadence", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe());
  recipe.guild.objective = "Monitor markets and post proposals.";
  recipe.meta.description = "Proposal-only research, reporting to guild chat every 15 minutes.";
  const prepared = prepareRecipeForApply(recipe);
  assert.equal(prepared.roles[0]?.schedules.length, 0);
});

test("fixture desk recipes are apply-ready against stub mail and crm", () => {
  const stubs = {
    publishedServers: new Set(["mail", "crm"]),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  };
  const complete = parseRecipe(fixtureDeskRecipe());
  assert.equal(blockingErrors(validateRecipe(complete, stubs)).length, 0);
  assert.equal(complete.roles.length, 2);
  assert.deepEqual(complete.connections.map((item) => item.server).sort(), ["crm", "mail"]);
  const husk = parseRecipe(fixtureHuskDeskRecipe(builderAuthor()));
  const findings = validateRecipe(husk, stubs);
  assert.ok(findings.some((item) => item.code === "task.derived"));
  assert.ok(findings.some((item) => item.code === "schedule.missing"));
  assert.ok(findings.some((item) => item.code === "connection.missing"));
  assert.equal(applyBlockingErrors(findings).some((item) => item.code === "review.required"), false);
  const prepared = prepareRecipeForApply(husk);
  assert.equal(prepared.roles.every((item) => item.task.body.trim().length > 0), true);
  assert.deepEqual(
    prepared.roles.flatMap((item) => item.schedules.map((row) => row.cron)),
    [],
  );
  assert.deepEqual(prepared.connections, []);
});

test("builder recipes warn when a single role has no specialization reason", () => {
  const husk = parseRecipe(huskLeadMatcherRecipe(builderAuthor()));
  const findings = validateRecipe(husk, { ...ctx, publishedServers: new Set(["notion", "cigale"]) });
  assert.ok(findings.some((item) => item.code === "design.single_role" && item.severity === "warning"));
  husk.design.specialization = [
    {
      role: "story-lead-matcher",
      reason: "other",
      detail: "One craft, one cadence, one playbook.",
      proposed_by: "builder",
      accepted: false,
    },
  ];
  const justified = validateRecipe(husk, { ...ctx, publishedServers: new Set(["notion", "cigale"]) });
  assert.equal(
    justified.some((item) => item.code === "design.single_role"),
    false,
  );
});

test("reserved names and omitted authorship", () => {
  const reservedRole = linkedInNotionRecipe();
  reservedRole.roles[0] = { ...reservedRole.roles[0]!, role: "user" };
  assert.throws(() => parseRecipe(reservedRole), /reserved/);
  const reservedName = linkedInNotionRecipe();
  reservedName.roles[0] = { ...reservedName.roles[0]!, name_suggestion: "user" };
  assert.throws(() => parseRecipe(reservedName), /reserved/);
  const raw = JSON.parse(JSON.stringify(linkedInNotionRecipe())) as Record<string, unknown>;
  const roles = raw.roles as Array<Record<string, unknown>>;
  const task = { ...(roles[0]?.task as Record<string, unknown>) };
  delete task.author;
  roles[0] = { ...roles[0], task };
  const fallback = parseRecipe(raw);
  assert.equal(fallback.roles[0]?.task.author.by, "builder");
  assert.equal(fallback.roles[0]?.task.author.reviewed, false);
});

test("builder writes stamp unreviewed authorship and preserve reviewed identical fields", () => {
  const previous = parseRecipe(linkedInNotionRecipe());
  const next = parseRecipe(linkedInNotionRecipe(builderAuthor()));
  next.roles[0]!.task.body = `${previous.roles[0]!.task.body} and ping @{writer}.`;
  const stamped = stampBuilderWrite(next, previous);
  assert.equal(stamped.roles[0]?.task.author.by, "builder");
  assert.equal(stamped.roles[0]?.task.author.reviewed, false);
  assert.equal(stamped.roles[1]?.task.author.by, "operator");
  assert.equal(stamped.roles[1]?.task.author.reviewed, true);
});

test("applyReview covers schedules, notes, and external cards", () => {
  const recipe = parseRecipe(linkedInNotionRecipe(builderAuthor()));
  recipe.notes.push({
    id: "playbook",
    level: "guild",
    key: "playbook.md",
    body: "Keep the queue moving.",
    kind: "seed",
    author: builderAuthor(),
    writers: [],
  });
  recipe.external.push({
    kind: "url",
    title: "CRM board",
    setup: "Open the board.",
    author: builderAuthor(),
  });
  applyReview(recipe, "roles.watcher.schedules.watch-feed", "confirm");
  applyReview(recipe, "notes.playbook", "confirm");
  applyReview(recipe, "external[0]", "edit", "Open the live board.");
  assert.equal(recipe.roles[0]?.schedules[0]?.author.reviewed, true);
  assert.equal(recipe.notes[0]?.author.reviewed, true);
  assert.equal(recipe.external[0]?.author.by, "operator");
  assert.equal(recipe.external[0]?.setup, "Open the live board.");
});

test("operator can remove connector tools and whole connectors", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  applyAccessEdit(recipe, { action: "set_tool", server: "mail", role: "reader", tool: "mail_ping", enabled: false });
  applyAccessEdit(recipe, { action: "set_tool", server: "mail", role: "reader", tool: "mail_list", enabled: false });
  assert.equal(recipe.connections.find((item) => item.server === "mail")?.roles.reader?.tools.mail_ping, false);
  const afterTools = validateRecipe(recipe, {
    publishedServers: new Set(["mail", "crm"]),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  });
  assert.ok(afterTools.some((item) => item.code === "access.tool_removed" && item.message.includes("mail_ping")));
  applyAccessEdits(recipe, [{ action: "remove_connection", server: "mail" }]);
  assert.equal(recipe.connections.some((item) => item.server === "mail"), false);
  assert.ok(
    recipe.design.systems.some(
      (item) => item.server === "mail" && item.resolution === "refused" && item.proposed_by === "operator",
    ),
  );
  const cuts = operatorAccessCuts(recipe);
  assert.ok(cuts.some((item) => item.kind === "connector" && item.server === "mail"));
  assert.ok(cuts.some((item) => item.kind === "tool" && item.tool === "mail_list") === false);
  const afterConnector = validateRecipe(recipe, {
    publishedServers: new Set(["mail", "crm"]),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  });
  assert.ok(afterConnector.some((item) => item.code === "access.connector_removed" && item.message.includes("mail")));
  assert.match(formatAccessCutsMessage(operatorAccessCuts(recipe)), /connector mail/);
});

test("unknown key errors list allowed keys and common aliases", () => {
  const base = emptyRecipe({ source: { kind: "file" } });
  assert.throws(
    () => parseRecipe({ ...base, roles: [{ name: "meta-scout", focus: "scout" }] }),
    /unknown key roles\[0\]\.name; use `role`.*allowed: role, name_suggestion/,
  );
  assert.throws(
    () => parseRecipe({ ...base, notes: [{ name: "playbook", level: "agent", purpose: "x" }] }),
    /unknown key notes\[0\]\.name; notes use `id`, `level`, `key`, and `body`/,
  );
  assert.throws(
    () => parseRecipe({ ...base, collections: [{ name: "queue", purpose: "x", role: "scout" }] }),
    /unknown key collections\[0\]\.role; .*`guild`.*`writers`.*allowed: name, purpose, columns, scope, guild, writers/,
  );
});

test("recipe notes are flat: a path property or a key with a folder is rejected", () => {
  const base = emptyRecipe({ source: { kind: "file" } });
  const note = { id: "brief", level: "guild", key: "brief.md", body: "Short.", kind: "seed" };
  const parsed = parseRecipe({ ...base, notes: [note] });
  assert.deepEqual(
    parsed.notes.map((item) => ({ level: item.level, key: item.key })),
    [{ level: "guild", key: "brief.md" }],
  );
  assert.equal("path" in (parsed.notes[0] ?? {}), false);
  assert.throws(
    () => parseRecipe({ ...base, notes: [{ ...note, path: "research" }] }),
    /unknown key notes\[0\]\.path; notes have no folders.*allowed: id, level, role, key, body, kind, author/,
  );
  assert.throws(
    () => parseRecipe({ ...base, notes: [{ ...note, path: "" }] }),
    /unknown key notes\[0\]\.path/,
  );
  assert.throws(
    () => parseRecipe({ ...base, notes: [{ ...note, key: "research/brief.md" }] }),
    /notes\[0\]\.key must be a \.md file name with no \//,
  );
  assert.throws(
    () => parseRecipe({ ...base, notes: [{ ...note, key: "brief" }] }),
    /notes\[0\]\.key must be a \.md file name with no \//,
  );
});

test("recipe repositories carry a name and a purpose, and nothing else", () => {
  const base = fixtureDeskRecipe() as Record<string, unknown>;
  assert.deepEqual(parseRecipe(base).repositories, []);
  const listed = parseRecipe({
    ...base,
    repositories: [{ name: "api", purpose: "The HTTP service." }],
  });
  assert.deepEqual(listed.repositories, [{ name: "api", purpose: "The HTTP service." }]);
  assert.throws(
    () =>
      parseRecipe({
        ...base,
        repositories: [{ name: "api", purpose: "", url: "https://github.com/o/api" }],
      }),
    /unknown key repositories\[0\]\.url/,
  );
  assert.throws(
    () => parseRecipe({ ...base, repositories: [{ name: "Api", purpose: "" }] }),
    /repositories\[0\]\.name must match/,
  );
  assert.throws(
    () =>
      parseRecipe({
        ...base,
        repositories: [
          { name: "api", purpose: "" },
          { name: "api", purpose: "" },
        ],
      }),
    /duplicate repository api/,
  );
});

test("coding roles count against the plan's coding agents", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  for (const role of recipe.roles) {
    role.config = { ...role.config, coding: true };
  }
  const findings = validateRecipe(recipe, { ...ctx, remainingCodingAgents: 0 });
  assert.ok(findings.some((item) => item.code === "capacity.coding" && item.severity === "error"));
  assert.ok(!validateRecipe(recipe, ctx).some((item) => item.code === "capacity.coding"));

  const unused = parseRecipe({
    ...(fixtureDeskRecipe() as Record<string, unknown>),
    repositories: [{ name: "api", purpose: "" }],
  });
  assert.ok(
    validateRecipe(unused, ctx).some(
      (item) => item.code === "repositories.unused" && item.severity === "warning",
    ),
  );
});

test("a role's model is a recommendation: a bad one warns and never blocks", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  recipe.roles[0]!.config = { ...recipe.roles[0]!.config, model: "kimi/kimi-for-coding", coding: false };
  const notCoding = validateRecipe(recipe, ctx);
  assert.ok(notCoding.some((item) => item.code === "model.coding" && item.severity === "warning"));
  assert.ok(!notCoding.some((item) => item.code.startsWith("model.") && item.severity === "error"));
  recipe.roles[0]!.config.coding = true;
  const blocked = validateRecipe(recipe, { ...ctx, connectedProviders: new Set() });
  assert.ok(blocked.some((item) => item.code === "model.not_connected" && item.severity === "warning"));
  const ready = validateRecipe(recipe, { ...ctx, connectedProviders: new Set(["kimi", "deepinfra"]) });
  assert.ok(!ready.some((item) => item.code.startsWith("model.")), JSON.stringify(ready));
  recipe.roles[0]!.config.model = "acme/model";
  const unknown = validateRecipe(recipe, ctx);
  assert.ok(unknown.some((item) => item.code === "model.unknown" && item.severity === "warning"));
});
