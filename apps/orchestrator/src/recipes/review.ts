import { RecipeError } from "./errors.js";
import { roleBrowses } from "./prepare.js";
import type { FieldAuthor, RecipeDocument, RecipeRole } from "../db/schema/index.js";
import { builderAuthor, markReviewed, operatorAuthor } from "./schema.js";

// Who wrote each reviewable field of a recipe, and the operator's review of it: a Builder write
// keeps a reviewed field reviewed only while its content stays the same.

export function unreviewedFields(recipe: RecipeDocument): string[] {
  const fields: string[] = [];
  const push = (path: string, author: FieldAuthor) => {
    if (!author.reviewed) {
      fields.push(path);
    }
  };
  for (const role of recipe.roles) {
    push(`roles.${role.role}.task`, role.task.author);
    if (roleBrowses(role)) {
      push(`roles.${role.role}.browser`, role.browser.author);
    }
    for (const script of role.scripts) {
      push(`roles.${role.role}.scripts.${script.name}`, script.author);
    }
    for (const schedule of role.schedules) {
      push(`roles.${role.role}.schedules.${schedule.key}`, schedule.author);
    }
  }
  for (const note of recipe.notes) {
    push(`notes.${note.id}`, note.author);
  }
  for (const connection of recipe.connections) {
    push(`connections.${connection.server}.setup`, connection.author);
  }
  for (const [index, card] of recipe.external.entries()) {
    push(`external[${index}]`, card.author);
  }
  return fields;
}

function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The previous author while the field was reviewed and its content is the same; the Builder otherwise. */
function preserveOrBuilder(previous: FieldAuthor | undefined, contents: { before: unknown; after: unknown }): FieldAuthor {
  if (previous?.reviewed && sameContent(contents.before, contents.after)) {
    return previous;
  }
  return builderAuthor();
}

function stampScripts(scripts: RecipeRole["scripts"], previous: RecipeRole["scripts"]): void {
  const prior = new Map(previous.map((item) => [item.name, item]));
  for (const script of scripts) {
    const before = prior.get(script.name);
    script.author = preserveOrBuilder(before?.author, { before: before?.source, after: script.source });
  }
}

function stampSchedules(schedules: RecipeRole["schedules"], previous: RecipeRole["schedules"]): void {
  const prior = new Map(previous.map((item) => [item.key, item]));
  for (const schedule of schedules) {
    const before = prior.get(schedule.key);
    schedule.author = preserveOrBuilder(before?.author, {
      before: { cron: before?.cron, instruction: before?.instruction },
      after: { cron: schedule.cron, instruction: schedule.instruction },
    });
  }
}

function stampRole(role: RecipeRole, prev: RecipeRole | undefined): void {
  role.task.author = preserveOrBuilder(prev?.task.author, { before: prev?.task.body, after: role.task.body });
  role.browser.author = preserveOrBuilder(prev?.browser.author, {
    before: prev?.browser.instructions,
    after: role.browser.instructions,
  });
  stampScripts(role.scripts, prev?.scripts ?? []);
  stampSchedules(role.schedules, prev?.schedules ?? []);
}

function stampNotes(notes: RecipeDocument["notes"], previous: RecipeDocument["notes"]): void {
  const prior = new Map(previous.map((note) => [note.id, note]));
  for (const note of notes) {
    const before = prior.get(note.id);
    note.author = preserveOrBuilder(before?.author, { before: before?.body, after: note.body });
  }
}

function stampConnections(connections: RecipeDocument["connections"], previous: RecipeDocument["connections"]): void {
  const prior = new Map(previous.map((item) => [item.server, item]));
  for (const connection of connections) {
    const before = prior.get(connection.server);
    connection.author = preserveOrBuilder(before?.author, {
      before: { setup: before?.setup, resources: before?.resources },
      after: { setup: connection.setup, resources: connection.resources },
    });
  }
}

function stampExternal(cards: RecipeDocument["external"], previous: RecipeDocument["external"]): void {
  for (const [index, card] of cards.entries()) {
    const before = previous[index];
    card.author = preserveOrBuilder(before?.author, { before: before?.setup, after: card.setup });
  }
}

/** Stamps the Builder as the author of each field of `next` that differs from `previous`. */
export function stampBuilderWrite(next: RecipeDocument, previous: RecipeDocument | null): RecipeDocument {
  const prevRoles = new Map((previous?.roles ?? []).map((role) => [role.role, role]));
  for (const role of next.roles) {
    stampRole(role, prevRoles.get(role.role));
  }
  stampNotes(next.notes, previous?.notes ?? []);
  stampConnections(next.connections, previous?.connections ?? []);
  stampExternal(next.external, previous?.external ?? []);
  return next;
}

/** A reviewable field: its author, and how an operator's edit writes its content. */
type ReviewField = { author: () => FieldAuthor; setAuthor: (author: FieldAuthor) => void; write: (value: string) => void };

/** A path pattern of reviewable fields and how to find the one a path names. */
type ReviewPath = { pattern: RegExp; field: (recipe: RecipeDocument, match: RegExpMatchArray) => ReviewField | null };

function roleNamed(recipe: RecipeDocument, role: string | undefined): RecipeRole | undefined {
  return recipe.roles.find((item) => item.role === role);
}

/** A field holding its own author and one text the operator edits. */
function ownField<T extends { author: FieldAuthor }>(item: T | undefined, write: (item: T, value: string) => void): ReviewField | null {
  if (!item) return null;
  return {
    author: () => item.author,
    setAuthor: (author) => {
      item.author = author;
    },
    write: (value) => write(item, value),
  };
}

const REVIEW_PATHS: readonly ReviewPath[] = [
  {
    pattern: /^roles\.([a-z][a-z0-9-]{0,62})\.task$/,
    field: (recipe, match) =>
      ownField(roleNamed(recipe, match[1])?.task, (task, value) => {
        task.body = value;
      }),
  },
  {
    pattern: /^roles\.([a-z][a-z0-9-]{0,62})\.browser$/,
    field: (recipe, match) =>
      ownField(roleNamed(recipe, match[1])?.browser, (browser, value) => {
        browser.instructions = value;
      }),
  },
  {
    pattern: /^roles\.([a-z][a-z0-9-]{0,62})\.scripts\.([a-z][a-z0-9_-]{0,62})$/,
    field: (recipe, match) =>
      ownField(roleNamed(recipe, match[1])?.scripts.find((row) => row.name === match[2]), (script, value) => {
        script.source = value;
      }),
  },
  {
    pattern: /^roles\.([a-z][a-z0-9-]{0,62})\.schedules\.([a-z][a-z0-9-]{0,62})$/,
    field: (recipe, match) =>
      ownField(roleNamed(recipe, match[1])?.schedules.find((row) => row.key === match[2]), (schedule, value) => {
        schedule.instruction = value;
      }),
  },
  {
    pattern: /^connections\.([a-z0-9][a-z0-9-]{0,62})\.setup$/,
    field: (recipe, match) =>
      ownField(recipe.connections.find((item) => item.server === match[1]), (connection, value) => {
        connection.setup = value;
      }),
  },
  {
    pattern: /^notes\.([A-Za-z0-9._:-]+)$/,
    field: (recipe, match) =>
      ownField(recipe.notes.find((row) => row.id === match[1]), (note, value) => {
        note.body = value;
      }),
  },
  {
    pattern: /^external\[(\d+)\]$/,
    field: (recipe, match) =>
      ownField(recipe.external[Number(match[1])], (card, value) => {
        card.setup = value;
      }),
  },
];

function reviewField(recipe: RecipeDocument, path: string): ReviewField | null {
  for (const entry of REVIEW_PATHS) {
    const match = path.match(entry.pattern);
    if (match) {
      return entry.field(recipe, match);
    }
  }
  return null;
}

/** The operator confirms a field as written, or edits it, which makes the operator its author. */
export type ReviewAction = { action: "confirm" } | { action: "edit"; value?: string | undefined };

/** The review a request asks for: `{ action: "edit", value }` edits, anything else confirms. */
export function parseReviewAction(body: Record<string, unknown>): ReviewAction {
  if (body.action !== "edit") {
    return { action: "confirm" };
  }
  return { action: "edit", value: typeof body.value === "string" ? body.value : undefined };
}

export function applyReview(recipe: RecipeDocument, path: string, review: ReviewAction): void {
  const field = reviewField(recipe, path);
  if (!field) {
    throw new RecipeError("field not found", 404);
  }
  if (review.action === "confirm") {
    field.setAuthor(markReviewed(field.author()));
    return;
  }
  field.setAuthor(operatorAuthor());
  if (review.value !== undefined) {
    field.write(review.value);
  }
}
