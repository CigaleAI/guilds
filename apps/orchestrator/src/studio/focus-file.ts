import { ArtifactError } from "../artifacts/errors.js";
import { artifactAt, parseActorPath, type ArtifactView } from "../artifacts/notes.js";
import { parseDisplayPath, TASK_KEY, type ParsedDisplayPath } from "../artifacts/paths.js";
import type { EvidenceAttributes } from "../conversation/trust.js";
import { getAgentTask, type AgentRow } from "../db/agents.js";
import type { ArtifactRow } from "../db/artifacts.js";
import { listFileChanges, type FileChangeView } from "../db/file-changes.js";
import type { StudioFocus } from "../db/schema/index.js";
import { studioActor, type StudioOperator } from "./actor.js";
import { StudioUnprocessableError } from "./errors.js";
import {
  emptyFocus,
  evidenceBlock,
  excerpt,
  RUN_KIND_LABELS,
  withoutRepeatedBlankLines,
  type ResolvedFocus,
} from "./focus-evidence.js";
import type { StudioFocusRequest } from "./focus.js";
import { studioChangeTarget, studioReachesParsed, type StudioReachDeps } from "./reach.js";
import { findGuildAgent, requireGuildAgent } from "./source-guild.js";

// A file pin: the file or record a display path names, refused outside what the session reaches,
// with its recorded changes, quoted to the coach.

/** What a file pin's path holds: an agent's Task, an archived Memory revision, or an artifact of its kind. */
export type FocusFileKind = "task" | "memory_revision" | ArtifactRow["kind"];

/**
 * A file as a pin quotes it: the agent whose file the path names (null for an organisation file),
 * what it is, whether it is deleted, its version, and its text.
 */
export type FocusFile = {
  owner: AgentRow | null;
  kind: FocusFileKind;
  deleted: boolean;
  version: number | null;
  content: string;
};

/**
 * A file a pin names, the agent the pin is on, the file's recorded changes newest first, and the
 * change the pin names; null when it names none.
 */
export type FileEvidence = {
  displayPath: string;
  file: FocusFile;
  agent: AgentRow | null;
  changes: FileChangeView[];
  pinnedChange: FileChangeView | null;
};

/**
 * The agent whose file a parsed path names, refused outside the source guild; null for an
 * organisation file, which is refused outside the source guild's reach.
 */
async function requireFileAgent(
  deps: StudioReachDeps,
  operator: StudioOperator,
  parsed: ParsedDisplayPath,
): Promise<AgentRow | null> {
  const agentId = parsed.kind === "revision" || parsed.kind === "artifact" ? parsed.agentId : null;
  if (agentId !== null) {
    return requireGuildAgent(deps.db, operator.sourceGuildId, operator.orgId, agentId);
  }
  if (!(await studioReachesParsed(deps, operator, parsed))) {
    throw new StudioUnprocessableError("focus file is not in the source guild's reach");
  }
  return null;
}

/** An agent's Task as a file pin quotes it. */
async function loadTaskFile(
  deps: StudioReachDeps,
  operator: StudioOperator,
  owner: AgentRow,
): Promise<FocusFile> {
  const task = await getAgentTask(deps.db, operator.orgId, owner.id);
  return {
    owner,
    kind: "task",
    deleted: false,
    version: task?.version ?? null,
    content: task?.content_text ?? "",
  };
}

/** What an artifact view holds as a file pin quotes it: an object's fields as JSON, any other row's text. */
function focusFileOfView(view: ArtifactView, owner: AgentRow | null): FocusFile {
  if (view.kind === "revision") {
    return { owner, kind: "memory_revision", deleted: false, version: null, content: view.content };
  }
  const { row } = view;
  const content =
    row.kind === "object"
      ? JSON.stringify(row.content_json ?? {}, null, 2)
      : (row.content_text ?? "");
  return { owner, kind: row.kind, deleted: view.deleted, version: row.version, content };
}

/** The file at `displayPath` as the session's operator reads it, refused outside what the session reaches. */
async function loadFileForFocus(
  deps: StudioReachDeps,
  operator: StudioOperator,
  displayPath: string,
): Promise<FocusFile> {
  const actor = studioActor(operator);
  try {
    const parsed = parseActorPath(actor, displayPath);
    if (parsed.kind === "collection") {
      throw new StudioUnprocessableError("focus on a collection is not supported; pick a record");
    }
    const owner = await requireFileAgent(deps, operator, parsed);
    if (owner && parsed.kind === "artifact" && parsed.path === "" && parsed.key === TASK_KEY) {
      return await loadTaskFile(deps, operator, owner);
    }
    return focusFileOfView(await artifactAt(deps.artifacts, actor, displayPath), owner);
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new StudioUnprocessableError(error.message);
    }
    throw error;
  }
}

/**
 * The file a pin names with its changes, and the agent the pin is on: the file's own, else the
 * source guild's agent the pin names.
 */
export async function loadFileEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<FileEvidence> {
  const displayPath = input.display_path;
  if (!displayPath) {
    throw new StudioUnprocessableError("focus file needs a display_path");
  }
  const file = await loadFileForFocus(deps, operator, displayPath);
  const agent =
    file.owner ??
    (input.agent_id
      ? await findGuildAgent(deps.db, operator.sourceGuildId, operator.orgId, input.agent_id)
      : null);
  const target = await studioChangeTarget(deps, operator, parseDisplayPath(displayPath));
  const changes = await listFileChanges(deps.db, operator.orgId, target);
  const changeId = input.change_id;
  if (!changeId) {
    return { displayPath, file, agent, changes, pinnedChange: null };
  }
  const pinnedChange = changes.find((row) => row.id === changeId);
  if (!pinnedChange) {
    throw new StudioUnprocessableError("focus file change not found");
  }
  return { displayPath, file, agent, changes, pinnedChange };
}

/** Who made a file change and when, in words. */
function changeSummary(change: FileChangeView): string {
  const runKind = change.run?.kind ? ` (${RUN_KIND_LABELS[change.run.kind].toLowerCase()})` : "";
  const tool = change.tool?.name ? ` via ${change.tool.name}` : "";
  const who =
    change.actor.type === "run"
      ? `run ${change.run?.id ?? change.actor.id}${runKind}${tool}`
      : `${change.actor.type} ${change.actor.name}`;
  return `${change.operation} to v${change.version} by ${who} at ${change.created_at}`;
}

/** The ids a file focus takes from the change it quotes: the change, and the run and tool call that made it. */
function changeFocusIds(
  change: FileChangeView | null,
): Pick<StudioFocus, "change_id" | "run_id" | "call_id" | "tool_name"> {
  if (!change) {
    return { change_id: null, run_id: null, call_id: null, tool_name: null };
  }
  return {
    change_id: change.id,
    run_id: change.run?.id ?? null,
    call_id: change.tool?.call_id ?? null,
    tool_name: change.tool?.name ?? null,
  };
}

/** The evidence attributes of the change a file pin quotes; none when the file has no recorded change. */
function changeCoordinates(change: FileChangeView | null): EvidenceAttributes {
  if (!change) {
    return {};
  }
  return {
    change_id: change.id,
    change_operation: change.operation,
    change_actor_type: change.actor.type,
    change_actor_name: change.actor.name,
    change_run_id: change.run?.id ?? null,
    change_run_kind: change.run?.kind ?? null,
    change_tool_call_id: change.tool?.call_id ?? null,
    change_tool_name: change.tool?.name ?? null,
    change_at: change.created_at,
  };
}

/** Where the coach reads further about a file: its change history, and the run that wrote the change. */
function fileTail(displayPath: string, change: FileChangeView | null): string {
  const history = `Full change history: studio_list_file_changes(display_path="${displayPath}").`;
  const run = change?.run;
  if (!run) {
    return history;
  }
  const call = change.tool?.call_id ? `; its tool call id is ${change.tool.call_id}` : "";
  return `${history} The writing run: studio_get_run(run_id="${run.id}")${call}.`;
}

/** A file pin as the coach reads it: the file, the change the pin names or its latest, and its text. */
export function formatFileFocus({
  displayPath,
  file,
  agent,
  changes,
  pinnedChange,
}: FileEvidence): ResolvedFocus {
  const change = pinnedChange ?? changes[0] ?? null;
  const kind = `${file.kind}${file.deleted ? " (deleted)" : ""}`;
  const changeLine = change
    ? `${pinnedChange ? "Focused change" : "Latest change"}: ${changeSummary(change)}.`
    : "No recorded change history for this path.";
  const body = withoutRepeatedBlankLines([
    `${kind} ${displayPath}${file.version !== null ? ` (v${file.version})` : ""}.`,
    changeLine,
    changes.length > 1 ? `${changes.length} recorded changes in total.` : "",
    "",
    "Content:",
    excerpt(file.content),
  ]);
  return {
    focus: {
      ...emptyFocus("file", agent),
      ...changeFocusIds(change),
      display_path: displayPath,
      label: `File · ${displayPath.split("/").pop() ?? displayPath}`,
    },
    content: evidenceBlock(
      "studio.focus.file",
      { display_path: displayPath, kind, version: file.version, ...changeCoordinates(change) },
      body.join("\n"),
      fileTail(displayPath, change),
    ),
  };
}
