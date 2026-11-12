import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactActor } from "../artifacts/types.js";
import { hereDir } from "../lib/paths.js";
import { errorMessage } from "../observability/log.js";
import { readArtifactText } from "./artifacts.js";
import type { ToolServices } from "./services.js";
import { ToolArgumentError } from "./errors.js";

/** The content of `notes` appended to a brief, at most. */
export const BRIEF_NOTES_MAX_BYTES = 64 * 1024;

/**
 * What every brief starts with, from `harness-brief.md`: what the harness cannot reach, where
 * it runs, and who reads its final message. The brief is the one text every harness reads.
 */
export const BRIEF_PREAMBLE = readFileSync(
  path.join(hereDir(import.meta.url), "harness-brief.md"),
  "utf8",
).trim();

type NoteSection = { path: string; section: string };
type FittedNotes = { used: number; included: string[]; left: string[] };

async function loadNote(
  services: ToolServices,
  actor: ArtifactActor | null,
  path: string,
): Promise<NoteSection> {
  try {
    const loaded = await readArtifactText(services, actor, path);
    return { path: loaded.path, section: `# ${loaded.path}\n\n${loaded.text.trim()}` };
  } catch (error) {
    throw new ToolArgumentError(`notes: ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

function addNote(fitted: FittedNotes, note: NoteSection): void {
  const size = Buffer.byteLength(note.section, "utf8");
  if (fitted.used + size > BRIEF_NOTES_MAX_BYTES) {
    fitted.left.push(note.path);
    return;
  }
  fitted.used += size;
  fitted.included.push(note.section);
}

/** The fixed preamble, the brief, and each note in order while the notes fit their cap. */
export function briefText(brief: string, notes: NoteSection[]): string {
  const fitted: FittedNotes = { used: 0, included: [], left: [] };
  notes.forEach((note) => addNote(fitted, note));
  const parts = [BRIEF_PREAMBLE, `# Task\n\n${brief.trim()}`, ...fitted.included];
  if (fitted.left.length) {
    parts.push(
      `Not included, past the ${BRIEF_NOTES_MAX_BYTES / 1024} KiB cap for notes: ${fitted.left.join(", ")}`,
    );
  }
  return parts.join("\n\n") + "\n";
}

/** The brief the harness reads, with each note under its display path; a note that does not load fails the call. */
export async function buildBrief(
  services: ToolServices,
  actor: ArtifactActor | null,
  brief: string,
  paths: string[],
): Promise<string> {
  const notes: NoteSection[] = [];
  for (const path of paths) {
    notes.push(await loadNote(services, actor, path));
  }
  return briefText(brief, notes);
}
