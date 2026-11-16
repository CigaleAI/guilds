import type { AgentNeeds } from "./machines";

/** The agent being placed on a machine: its id when it already exists, and what it needs. */
export type AgentToPlace = { id?: string | undefined } & AgentNeeds;
