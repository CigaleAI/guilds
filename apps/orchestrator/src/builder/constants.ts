export const BUILDER_MAX_TOKENS = 25000;
export const BUILDER_MAX_STEPS = 24;
export const BUILDER_MAX_TOOL_CALLS = 40;
export const BUILDER_MAX_INPUT_TOKENS = 200_000;
export const BUILDER_DEFAULT_TEMPERATURE = 0.2;
export const RECIPE_WRITE_HINT =
  "Role handle is `role` (never `name`). Standing prompt is `task.body` (a string, never `text`). Shared files that must enter every run use `![[guild/<key>]]` / `![[org/<key>]]` / `![[agent/<role>/<key>]]` in `task.body` plus the same href in `task.embeds`; a bare filename does not inline. Role wakes are `schedules` with string `instruction` (never `routines` or `memory` on the role). `design.routines` is metadata about those schedule keys. Notes use `{ id, level, key, body, kind }` where `key` is a `.md` file name with no `/` (notes have no folders). connections.roles is an object keyed by role, each `{ enabled, tools }`, not an array of names. connections.resources is optional `[{ kind, id, title, url?, use? }]` for confirmed long-lived Notion (or similar) tables — not queues. Native group ids (notes, collections, memory, schedules, browser) are tool groups, not role keys.";
