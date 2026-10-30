import { Buffer } from "node:buffer";
import type { ArtifactActor } from "../artifacts/types.js";
import { errorMessage } from "../observability/log.js";
import { readArtifactText } from "./artifacts.js";
import type { ToolServices } from "./services.js";

/** The content of `notes` appended to a brief, at most. */
export const BRIEF_NOTES_MAX_BYTES = 64 * 1024;

/** What every brief starts with: the harness works alone and never publishes. */
export const BRIEF_PREAMBLE = [
  "You are working on a task delegated to you by an agent. You cannot reach its operator, and",
  "nobody answers questions while you work. When you are blocked or need a decision, stop and",
  "ask in your final message, saying exactly what you need. You may commit on the current",
  "branch. Never push and never open pull requests. End with what you changed and what you ran.",
].join("\n");

type NoteSection = { path: string; section: string };
type FittedNotes = { used: number; included: string[]; left: string[] };

async function loadNote(services: ToolServices, actor: ArtifactActor | null, path: string): Promise<NoteSection> {
  try {
    const loaded = await readArtifactText(services, actor, path);
    return { path: loaded.path, section: `# ${loaded.path}\n\n${loaded.text.trim()}` };
  } catch (error) {
    throw new Error(`notes: ${path}: ${errorMessage(error)}`, { cause: error });
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
    parts.push(`Not included, past the ${BRIEF_NOTES_MAX_BYTES / 1024} KiB cap for notes: ${fitted.left.join(", ")}`);
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
