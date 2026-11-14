import type { StudioTool } from "../../../api/types/studio";

// What each native tool does, in a sentence an operator new to it understands; the catalog's own
// description is written for the model.
const NATIVE_TOOL_SUMMARIES: ReadonlyMap<string, string> = new Map([
  ["note_find", "Looks through the notes the agent may read to find the one it needs."],
  ["note_get", "Opens one note so the agent can read it."],
  ["note_write", "Writes a new note, or updates one the agent may change."],
  ["note_delete", "Deletes a note the agent may change."],
  ["record_search", "Searches the records of your collections for matching words."],
  ["record_list", "Lists the records of one collection, narrowed down and sorted as needed."],
  ["record_add", "Adds a new record to a collection."],
  ["record_update", "Changes some values of an existing record and keeps the rest."],
  ["record_remove", "Deletes one record from a collection."],
  ["file_find", "Looks through the shared files the agent may read, by name and description."],
  ["file_fetch", "Copies a shared file onto the agent's machine so it can work with it."],
  ["file_put", "Shares a file from the agent's machine so others in the organisation can find it."],
  ["file_delete", "Deletes a shared file the agent may change."],
  ["memory_write", "Rewrites the agent's Memory: what it should remember for its next runs."],
  [
    "group_post",
    "Posts a message in the guild's group chat, and can ask an agent or you to reply.",
  ],
  [
    "report_issue",
    "Tells you when something the agent relies on is broken, such as a failing tool.",
  ],
  ["script_create", "Saves a small program the agent can run again later."],
  ["script_list", "Lists the agent's saved scripts and what each one is for."],
  ["script_read", "Shows the code of one of the agent's saved scripts."],
  ["script_run", "Runs one of the agent's saved scripts."],
  ["script_delete", "Deletes one of the agent's saved scripts."],
  ["schedule_create_cron", "Wakes the agent up on a regular clock, such as every Monday at 9."],
  ["schedule_create_window", "Wakes the agent up at random times within a daily time window."],
  ["schedule_list", "Lists the agent's schedules and when each one next wakes it."],
  ["schedule_update", "Changes the timing or the instructions of one of the agent's schedules."],
  ["schedule_pause", "Pauses a schedule so it stops waking the agent."],
  ["schedule_resume", "Restarts a paused schedule."],
  ["schedule_delete", "Deletes one of the agent's schedules."],
  ["browse", "Hands a whole web task to the agent's browser, which reports what it found."],
  ["browser_navigate", "Opens a web page in the agent's browser."],
  ["browser_snapshot", "Reads what is on the current web page."],
  ["browser_click", "Clicks a button or a link on the current web page."],
  ["browser_type", "Types text into a box on the current web page."],
  ["browser_fill", "Fills in a form field on the current web page, replacing what was there."],
  ["browser_scroll", "Scrolls the current web page up, down, left or right."],
  ["browser_screenshot", "Takes a picture of the current web page."],
  ["browser_eval", "Runs a small piece of code in the current web page to read or change it."],
  ["shell", "Runs a command on the agent's machine."],
  ["shell_status", "Checks on, or stops, the commands left running on the agent's machine."],
  ["file_read", "Reads a text file on the agent's machine."],
  ["code_search", "Searches the files on the agent's machine for matching text."],
  [
    "code_task",
    "Hands a coding job on one of the guild's repositories to the agent's coding assistant.",
  ],
  [
    "secret_store",
    "Keeps a key or password the agent made, so it can use it later without showing it.",
  ],
  ["secret_request", "Asks you for a key or password the agent needs; you enter it privately."],
  [
    "wake_after",
    "Has the agent check back in a few minutes, such as when a long job should be done.",
  ],
  ["wake_cancel", "Cancels the agent's planned check-back."],
]);

/**
 * A native tool's summary for the operator: its own sentence, or the catalog's description for a
 * native tool without one. Null for a script or connection tool.
 */
export function nativeToolSummary(tool: StudioTool): string | null {
  if (tool.source !== "native") return null;
  return NATIVE_TOOL_SUMMARIES.get(tool.name) ?? tool.description;
}
