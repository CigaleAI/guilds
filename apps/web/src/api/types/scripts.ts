/**
 * Shapes of the orchestrator's JSON API for agents' scripts, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** A Python script in the agent's home. One with parameters is also a tool named after it. */
export type Script = {
  name: string;
  description: string;
  /** A JSON Schema object for the tool's arguments, or null for a plain script. */
  parameters: Record<string, unknown> | null;
  source: string;
  display_path?: string;
};
