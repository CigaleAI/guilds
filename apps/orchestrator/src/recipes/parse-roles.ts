import { WAKE_TRIGGERS_MAX } from "../agents/validation.js";
import type { WakeWindow, RecipeRole, RecipeSchedule, RecipeScript } from "../db/schema/index.js";
import { RecipeError } from "./errors.js";
import {
  asBool,
  asString,
  assertKeys,
  assertObject,
  boundedText,
  listOf,
  parseAuthor,
  parseBoolMap,
  textList,
} from "./parse-fields.js";
import { builderAuthor, RECIPE_SETUP_MAX, RECIPE_TASK_MAX_BYTES, ROLE_RE, ROUTINE_KEY_RE } from "./schema.js";

// A recipe's roles: each with its config, task, scripts, routines, native tools and browser login.

const ROLE_KEYS = [
  "role",
  "name_suggestion",
  "focus",
  "wake_triggers",
  "avatar_shape",
  "avatar_color",
  "config",
  "task",
  "scripts",
  "schedules",
  "native_tools",
  "browser",
];

/** A role handle or agent name: a lowercase slug other than the reserved `user`. */
function parseHandle(value: unknown, path: string, fallback = ""): string {
  const name = asString(value, path, fallback);
  if (!ROLE_RE.test(name)) {
    throw new RecipeError(`${path} must match ^[a-z][a-z0-9-]{0,62}$`);
  }
  if (name === "user") {
    throw new RecipeError(`${path} is reserved`);
  }
  return name;
}

function parseScript(value: unknown, path: string): RecipeScript {
  const record = assertObject(value, path);
  assertKeys(record, ["name", "description", "parameters", "source", "secrets", "author"], path);
  const parameters =
    record.parameters === undefined || record.parameters === null ? null : assertObject(record.parameters, `${path}.parameters`);
  return {
    name: asString(record.name, `${path}.name`),
    description: asString(record.description, `${path}.description`),
    parameters,
    source: boundedText(record.source, `${path}.source`, RECIPE_TASK_MAX_BYTES),
    secrets: textList(record.secrets, `${path}.secrets`),
    author: parseAuthor(record.author, builderAuthor()),
  };
}

function parseWakeWindow(value: unknown, path: string): WakeWindow {
  const record = assertObject(value, path);
  assertKeys(record, ["timezone", "start", "end", "max_wakes"], path);
  if (typeof record.max_wakes !== "number") {
    throw new RecipeError(`${path}.max_wakes must be a number`);
  }
  return {
    timezone: asString(record.timezone, `${path}.timezone`),
    start: asString(record.start, `${path}.start`),
    end: asString(record.end, `${path}.end`),
    max_wakes: record.max_wakes,
  };
}

function parseSchedule(value: unknown, path: string): RecipeSchedule {
  const record = assertObject(value, path);
  assertKeys(record, ["key", "cron", "window", "description", "instruction", "author"], path);
  const key = asString(record.key, `${path}.key`);
  if (!ROUTINE_KEY_RE.test(key)) {
    throw new RecipeError(`${path}.key must match ${ROUTINE_KEY_RE}`);
  }
  return {
    key,
    ...(record.cron !== undefined && record.cron !== null ? { cron: asString(record.cron, `${path}.cron`) } : {}),
    ...(record.window !== undefined && record.window !== null
      ? { window: parseWakeWindow(record.window, `${path}.window`) }
      : {}),
    description: asString(record.description, `${path}.description`),
    instruction: boundedText(record.instruction, `${path}.instruction`, RECIPE_SETUP_MAX),
    author: parseAuthor(record.author, builderAuthor()),
  };
}

function parseTask(value: unknown, path: string): RecipeRole["task"] {
  const record = value === undefined ? {} : assertObject(value, path);
  assertKeys(record, ["body", "embeds", "author"], path);
  return {
    body: boundedText(record.body, `${path}.body`, RECIPE_TASK_MAX_BYTES),
    embeds: textList(record.embeds, `${path}.embeds`),
    author: parseAuthor(record.author, builderAuthor()),
  };
}

/** The role's browser login; it is required exactly when the role's config turns the browser on, if it says. */
function parseBrowser(value: unknown, config: Record<string, unknown>, path: string): RecipeRole["browser"] {
  const record = value === undefined ? {} : assertObject(value, path);
  assertKeys(record, ["required", "instructions", "author"], path);
  const instructions = boundedText(record.instructions, `${path}.instructions`, RECIPE_SETUP_MAX);
  const required = asBool(record.required, `${path}.required`, Boolean(config.browser));
  if (required !== Boolean(config.browser) && config.browser !== undefined) {
    throw new RecipeError(`${path}.required must match config.browser`);
  }
  return {
    required,
    instructions,
    author: parseAuthor(record.author, builderAuthor()),
  };
}

function parseWakeTriggers(value: unknown, path: string): string {
  const wakeTriggers = asString(value, path).trim();
  if (wakeTriggers.length > WAKE_TRIGGERS_MAX) {
    throw new RecipeError(`${path} must be at most ${WAKE_TRIGGERS_MAX} characters`);
  }
  return wakeTriggers;
}

export function parseRole(value: unknown, index: number): RecipeRole {
  const path = `roles[${index}]`;
  const record = assertObject(value, path);
  assertKeys(record, ROLE_KEYS, path);
  const role = parseHandle(record.role, `${path}.role`);
  const wakeTriggers = parseWakeTriggers(record.wake_triggers, `${path}.wake_triggers`);
  const config = record.config === undefined ? {} : assertObject(record.config, `${path}.config`);
  const task = parseTask(record.task, `${path}.task`);
  const browser = parseBrowser(record.browser, config, `${path}.browser`);
  return {
    role,
    name_suggestion: parseHandle(record.name_suggestion, `${path}.name_suggestion`, role),
    focus: asString(record.focus, `${path}.focus`),
    wake_triggers: wakeTriggers,
    avatar_shape: asString(record.avatar_shape, `${path}.avatar_shape`, "teardrop"),
    avatar_color: asString(record.avatar_color, `${path}.avatar_color`, "#7c5cff"),
    config,
    task,
    scripts: listOf(record.scripts).map((item, scriptIndex) => parseScript(item, `${path}.scripts[${scriptIndex}]`)),
    schedules: listOf(record.schedules).map((item, scheduleIndex) => parseSchedule(item, `${path}.schedules[${scheduleIndex}]`)),
    native_tools: parseBoolMap(record.native_tools, `${path}.native_tools`),
    browser,
  };
}
