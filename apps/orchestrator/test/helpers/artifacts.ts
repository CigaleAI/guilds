import type { ArtifactRow } from "../../src/db/artifacts.js";
import { parseDisplayPath } from "../../src/artifacts/paths.js";

const STAMP = "2026-09-22T05:42:10.000Z";

/** An artifact row as the store reads it: an organisation note unless `overrides` says otherwise. */
export function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "art_1",
    org_id: "org_1",
    level: "org",
    owner_id: "org_1",
    guild_id: null,
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
    level: parsed.level,
    owner_id: parsed.ownerId,
    guild_id: parsed.level === "guild" ? parsed.ownerId : null,
    agent_id: parsed.level === "agent" ? parsed.ownerId : null,
    path: parsed.path,
    key: parsed.key,
    content_text: content,
    ...overrides,
  });
}
