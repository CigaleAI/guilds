import { createContext, useContext } from "react";
import type { StudioAgent, StudioSession } from "../../api/types/studio";
import type { Approvals } from "./approvals";
import type { StudioPin } from "./investigate";
import type { StudioSearch } from "./location";

/** Evidence pinned to the operator's next message: a run or step, a memory version, a routine, a file. */
export type StudioFocus = StudioPin["focus"];

/** A run step to open in the History tab of the agent that ran it. */
export type StudioStep = {
  agentId: string;
  runId: string;
  call?: string | null;
  seq?: number | null;
};

export type StudioView = {
  session: StudioSession;
  /** The guild's agents. */
  agents: StudioAgent[];
  search: StudioSearch;
  /** Points the inspector somewhere else; `replace` keeps the current history entry. */
  go: (next: StudioSearch, options?: { replace?: boolean }) => void;
  /** Opens a run at a step, in the History tab of the agent that ran it. */
  openStep: (step: StudioStep) => void;
  /** Pins evidence to the operator's next message to the coach. */
  ask: (focus: StudioFocus) => void;
  /** The coach's open requests, and how to answer them. */
  approvals: Approvals;
};

export const StudioContext = createContext<StudioView | null>(null);

/** The session the inspector belongs to, and how to move it or pin what it shows. */
export function useStudio(): StudioView {
  const view = useContext(StudioContext);
  if (!view) throw new Error("useStudio is only available inside a Studio session");
  return view;
}
