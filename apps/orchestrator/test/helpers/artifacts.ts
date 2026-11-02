import type { ArtifactRow } from "../../src/db/artifacts.js";
import { parseDisplayPath } from "../../src/artifacts/paths.js";
import { operatorActor } from "../../src/artifacts/actors.js";
import { listPathChanges } from "../../src/artifacts/host-files.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { FileChangeView } from "../../src/db/file-changes.js";
import type { Queryable } from "../../src/db/pg.js";

const STAMP = "2026-09-22T05:42:10.000Z";

/** An artifact row as the store reads it: an organisation note unless `overrides` says otherwise. */
export function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "art_1",
    org_id: "org_1",
    agent_id: null,
    origin_guild_id: null,
    kind: "note",
    collection_id: null,
    collection_name: null,
    path: "",
    key: "note.md",
    title: null,
    content_text: "",
    content_json: null,
    search_text: null,
    mime: null,
    bytes: null,
    version: 1,
    created_by_name: "operator",
    updated_by_name: "operator",
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

/** The note row a display path names, holding `content`. */
export function noteRowAt(displayPath: string, content: string, overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  const parsed = parseDisplayPath(displayPath);
  if (parsed.kind !== "artifact") {
    throw new Error(`${displayPath} names no note`);
  }
  return artifactRow({
    org_id: parsed.orgId,
    agent_id: parsed.agentId,
    path: parsed.path,
    key: parsed.key,
    content_text: content,
    ...overrides,
  });
}

/** The changes an operator of the organisation reads at a display path, newest first. */
export async function changesAt(db: Queryable, orgId: string, displayPath: string): Promise<FileChangeView[]> {
  const operator = operatorActor({ orgId, actorId: "user_operator", actorName: "operator" });
  return listPathChanges({ store: artifactStore(db), db }, operator, displayPath);
}
