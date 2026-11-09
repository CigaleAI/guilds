import assert from "node:assert/strict";
import { test } from "node:test";
import { BuilderService } from "../../src/builder/index.js";
import type { BuilderSessionRow } from "../../src/db/builder.js";
import type { Queryable } from "../../src/db/pg.js";
import type { StudioSessionRow } from "../../src/db/studio.js";
import { StudioService } from "../../src/studio/index.js";

/** A query the fake database was sent. */
type SentQuery = { text: string; params: unknown[] };

/**
 * A database whose sessions table holds `session`: a compare-and-set to cancelling matches only
 * while a generation runs on it, and a recipe read finds the recipe.
 */
function sessionDatabase(
  table: string,
  session: StudioSessionRow | BuilderSessionRow,
): { db: Queryable; queries: SentQuery[] } {
  const queries: SentQuery[] = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (text.startsWith(`UPDATE ${table}`) && text.includes("generation_state = 'generating'")) {
        const generating = session.generation_state === "generating";
        return { rows: generating ? [{ ...session, generation_state: "cancelling" }] : [] };
      }
      if (text.includes("FROM recipes")) {
        return { rows: [{ id: "recipe-1" }] };
      }
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, queries };
}

function studioSession(generationState: StudioSessionRow["generation_state"]): StudioSessionRow {
  return {
    id: "session-1",
    org_id: "org-1",
    status: "active",
    generation_state: generationState,
    config_snapshot: { model: "openai/gpt-5", temperature: 0 },
    granted_connection_ids: [],
  } as never;
}

function builderSession(generationState: BuilderSessionRow["generation_state"]): BuilderSessionRow {
  return { id: "session-1", org_id: "org-1", recipe_id: "recipe-1", status: "active", generation_state: generationState } as never;
}

/** Whether every write the database was sent leaves a session alone unless a generation runs on it. */
function writesOnlyAGeneratingSession(queries: SentQuery[]): boolean {
  return queries
    .filter(({ text }) => text.startsWith("UPDATE"))
    .every(({ text }) => text.includes("generation_state = 'generating'"));
}


function studioService(db: Queryable): StudioService {
  return new StudioService({
    db,
    artifacts: {} as never,
    scripts: {} as never,
    schedules: {} as never,
    notesSystemPath: "system.md",
  });
}

function builderService(db: Queryable): BuilderService {
  return new BuilderService({ db, capabilities: {} as never, apply: {} as never });
}

for (const [named, state] of [["an_idle", "idle"], ["a_cancelling", "cancelling"]] as const) {
  test(`studio_cancel_of_${named}_session_is_a_noop`, async () => {
    const session = studioSession(state);
    const { db, queries } = sessionDatabase("studio_sessions", session);
    const studio = studioService(db);
    const cancelled: string[] = [];
    studio.runner.cancel = (sessionId) => {
      cancelled.push(sessionId);
    };
    const view = await studio.cancel(session);
    assert.deepEqual(view, studio.viewSession(session));
    assert.ok(writesOnlyAGeneratingSession(queries));
    assert.deepEqual(cancelled, []);
  });

  test(`builder_cancel_of_${named}_session_is_a_noop`, async () => {
    const session = builderSession(state);
    const { db, queries } = sessionDatabase("builder_sessions", session);
    const builder = builderService(db);
    const cancelled: string[] = [];
    builder.runner.cancel = (sessionId) => {
      cancelled.push(sessionId);
    };
    const view = await builder.cancel(session);
    assert.equal(view.generation_state, state);
    assert.equal(view.recipe?.id, "recipe-1");
    assert.ok(writesOnlyAGeneratingSession(queries));
    assert.deepEqual(cancelled, []);
  });
}

test("studio_cancel_of_a_generating_session_marks_it_cancelling_and_stops_its_generation", async () => {
  const { db } = sessionDatabase("studio_sessions", studioSession("generating"));
  const studio = studioService(db);
  const cancelled: string[] = [];
  studio.runner.cancel = (sessionId) => {
    cancelled.push(sessionId);
  };
  const view = await studio.cancel(studioSession("generating"));
  assert.equal(view.generation_state, "cancelling");
  assert.deepEqual(cancelled, ["session-1"]);
});

test("builder_cancel_of_a_generating_session_marks_it_cancelling_and_stops_its_generation", async () => {
  const { db } = sessionDatabase("builder_sessions", builderSession("generating"));
  const builder = builderService(db);
  const cancelled: string[] = [];
  builder.runner.cancel = (sessionId) => {
    cancelled.push(sessionId);
  };
  const view = await builder.cancel(builderSession("generating"));
  assert.equal(view.generation_state, "cancelling");
  assert.equal(view.recipe, null);
  assert.deepEqual(cancelled, ["session-1"]);
});
