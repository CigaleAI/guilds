import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioFocus } from "../../api/types/studio";
import { studioStartAtRun } from "../agent/chat/SessionChrome";
import {
  agentTab,
  focusLocation,
  landingSessionLocation,
  parseStudioLandingSearch,
  parseStudioSearch,
  revealedStep,
  runHistoryLocation,
  tablePathOf,
} from "./location";

/** A pin of `kind` naming only the ids given, on no agent unless they name one. */
function pin(fields: Pick<StudioFocus, "kind"> & Partial<StudioFocus>): StudioFocus {
  return {
    agent_id: null,
    agent_name: null,
    label: "",
    run_id: null,
    seq: null,
    call_id: null,
    tool_name: null,
    revision_id: null,
    version_index: null,
    schedule_id: null,
    display_path: null,
    change_id: null,
    issue_id: null,
    ...fields,
  };
}

test("a run or issue pin opens the agent's History at the step", () => {
  assert.deepEqual(
    focusLocation(
      pin({
        kind: "run",
        agent_id: "a_1",
        run_id: "r_1",
        call_id: "c_1",
        seq: 4,
      }),
    ),
    { section: "agents", agent: "a_1", tab: "history", item: "r_1", call: "c_1", seq: 4 },
  );
  assert.deepEqual(focusLocation(pin({ kind: "issue", agent_id: "a_1", run_id: "r_1" })), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
  });
  assert.equal(focusLocation(pin({ kind: "issue" })), null);
});

test("a memory or routine pin opens its agent's tab", () => {
  assert.deepEqual(
    focusLocation(pin({ kind: "memory_version", agent_id: "a_1", revision_id: null })),
    { section: "agents", agent: "a_1", tab: "memory", item: "live" },
  );
  assert.equal(focusLocation(pin({ kind: "memory_version" })), null);
  assert.deepEqual(focusLocation(pin({ kind: "routine", agent_id: "a_1", schedule_id: "s_1" })), {
    section: "agents",
    agent: "a_1",
    tab: "routines",
    item: "s_1",
  });
  assert.equal(focusLocation(pin({ kind: "routine", agent_id: "a_1" })), null);
});

test("a file pin opens State with the file selected, and a record its table", () => {
  assert.deepEqual(
    focusLocation(
      pin({
        kind: "file",
        agent_id: "a_1",
        display_path: "org/o/agents/a_1/scripts/calc_valuation",
      }),
    ),
    {
      section: "state",
      agent: "a_1",
      tab: "list",
      item: "org/o/agents/a_1/scripts/calc_valuation",
    },
  );
  assert.deepEqual(
    focusLocation(pin({ kind: "file", agent_id: "a_1", display_path: "org/o/collections/c/12" })),
    { section: "state", agent: "a_1", tab: "list", item: "org/o/collections/c" },
  );
  assert.deepEqual(focusLocation(pin({ kind: "file", agent_id: "a_1" })), {
    section: "state",
    agent: "a_1",
    tab: "list",
  });
});

test("a file pin on no agent opens State without an agent", () => {
  assert.deepEqual(focusLocation(pin({ kind: "file", display_path: "org/o/notes/brief.md" })), {
    section: "state",
    tab: "list",
    item: "org/o/notes/brief.md",
  });
});

test("a table's path is its own, and a record's names its table", () => {
  assert.equal(tablePathOf("org/o/collections/c"), "org/o/collections/c");
  assert.equal(tablePathOf("org/o/collections/c/12"), "org/o/collections/c");
  assert.equal(tablePathOf("org/o/a.md"), null);
});

test("a tool pin points nowhere", () => {
  assert.equal(focusLocation(pin({ kind: "tool", agent_id: "a_1", tool_name: "web_fetch" })), null);
});

test("a URL without a known section opens the guild overview", () => {
  assert.deepEqual(parseStudioSearch({}), { section: "guild" });
  assert.deepEqual(parseStudioSearch({ agent: "a_1", tab: "memory" }), { section: "guild" });
  assert.deepEqual(parseStudioSearch({ section: "files", agent: "a_1" }), { section: "guild" });
});

test("the agents section keeps an agent's tab and step, and the topology selection", () => {
  assert.deepEqual(
    parseStudioSearch({ section: "agents", agent: "a_1", tab: "memory", seq: "3", call: "c" }),
    { section: "agents", agent: "a_1", tab: "memory", call: "c", seq: 3 },
  );
  assert.deepEqual(parseStudioSearch({ section: "agents", agent: "a_1", tab: "list", seq: "-1" }), {
    section: "agents",
    agent: "a_1",
  });
  assert.deepEqual(
    parseStudioSearch({ section: "agents", tab: "memory", item: "link:operator>a_1", seq: "2" }),
    { section: "agents", item: "link:operator>a_1" },
  );
});

test("State keeps its view, agent filter, kind and selection", () => {
  assert.deepEqual(
    parseStudioSearch({
      section: "state",
      agent: "a_1",
      tab: "references",
      kind: "table",
      item: "t_1",
      seq: "2",
    }),
    { section: "state", agent: "a_1", tab: "references", kind: "table", item: "t_1" },
  );
  assert.deepEqual(parseStudioSearch({ section: "state", tab: "memory", kind: "runs" }), {
    section: "state",
  });
});

test("Tools keeps only the selected tool", () => {
  assert.deepEqual(parseStudioSearch({ section: "tools", item: "note_get", agent: "a_1" }), {
    section: "tools",
    item: "note_get",
  });
});

test("an agent opens on the tab asked for, else where a request waits, else Prompt", () => {
  const tabs = ["prompt", "draft", "memory", "routines"] as const;
  assert.equal(agentTab("routines", ["memory"], tabs), "routines");
  assert.equal(agentTab("scripts", ["memory"], tabs), "memory");
  assert.equal(agentTab(undefined, ["list", "draft"], tabs), "draft");
  assert.equal(agentTab(undefined, [], tabs), "prompt");
});

test("a run's History location opens the agent's History on the run, at the step given", () => {
  assert.deepEqual(runHistoryLocation("a_1", "r_1", { call: "c_1", seq: 0 }), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
    call: "c_1",
    seq: 0,
  });
  assert.deepEqual(runHistoryLocation("a_1", "r_1", {}), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
  });
});

test("Studio's start keeps its guild, and with it a run named by its agent and id, at a step", () => {
  assert.deepEqual(
    parseStudioLandingSearch({ guild: "g_1", agent: "a_1", run: "r_1", call: "c_1", seq: "2" }),
    { guild: "g_1", agent: "a_1", run: "r_1", call: "c_1", seq: 2 },
  );
  assert.deepEqual(parseStudioLandingSearch({ guild: "g_1", agent: "a_1", run: "r_1", seq: "-1" }), {
    guild: "g_1",
    agent: "a_1",
    run: "r_1",
  });
  assert.deepEqual(parseStudioLandingSearch({ guild: "g_1" }), { guild: "g_1" });
  assert.deepEqual(parseStudioLandingSearch({}), {});
});

test("Studio's start drops a run without its guild, and an agent or run without the other", () => {
  assert.deepEqual(parseStudioLandingSearch({ agent: "a_1", run: "r_1" }), {});
  assert.deepEqual(parseStudioLandingSearch({ guild: "g_1", run: "r_1", call: "c_1" }), {
    guild: "g_1",
  });
  assert.deepEqual(parseStudioLandingSearch({ guild: "g_1", agent: "a_1", seq: "3" }), {
    guild: "g_1",
  });
});

test("a session on the start's guild opens at the run it names, in its agent's History", () => {
  const link = { guild: "g_1", agent: "a_1", run: "r_1", call: "c_1", seq: 4 };
  assert.deepEqual(landingSessionLocation(link, "g_1"), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
    call: "c_1",
    seq: 4,
  });
  assert.deepEqual(landingSessionLocation({ guild: "g_1", agent: "a_1", run: "r_1" }, "g_1"), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
  });
});

test("a session on another guild, or a start naming no run, opens where it would anyway", () => {
  assert.equal(landingSessionLocation({ guild: "g_1", agent: "a_1", run: "r_1" }, "g_2"), null);
  assert.equal(landingSessionLocation({ guild: "g_1" }, "g_1"), null);
  assert.equal(landingSessionLocation({}, "g_1"), null);
});

/** A search as a URL holds it: each value as text. */
function asUrl(search: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(search).map(([key, value]) => [key, String(value)]));
}

test("a run open in Chat opens the same run and step in Studio's History, from a link or a refresh", () => {
  const start = parseStudioLandingSearch(
    asUrl(studioStartAtRun("g_1", "a_1", "r_1", { run: "r_1", call: "c_1", seq: 4 })),
  );
  const location = landingSessionLocation(start, "g_1");
  assert.deepEqual(location, {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
    call: "c_1",
    seq: 4,
  });
  assert.ok(location);
  assert.deepEqual(parseStudioSearch(asUrl(location)), location);
  assert.deepEqual(revealedStep(parseStudioSearch(asUrl(location))), { call: "c_1", seq: 4 });
});

test("a location reveals the call and the row it names in its run", () => {
  assert.deepEqual(
    revealedStep({
      section: "agents",
      agent: "a_1",
      tab: "history",
      item: "r_1",
      call: "c_1",
      seq: 0,
    }),
    { call: "c_1", seq: 0 },
  );
  assert.deepEqual(
    revealedStep({ section: "agents", agent: "a_1", tab: "history", item: "r_1" }),
    {},
  );
});
