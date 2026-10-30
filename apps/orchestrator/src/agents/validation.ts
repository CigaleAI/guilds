import { normalizeAvatarColor, normalizeAvatarShape } from "../avatars/index.js";
import { NAME_RE } from "../lib/names.js";

export const FOCUS_MAX = 150;
export const WAKE_TRIGGERS_MAX = 500;

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

export function validateAgentName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new AgentValidationError("name must match ^[a-z][a-z0-9-]{0,62}$");
  }
  if (name === "user") {
    throw new AgentValidationError("name 'user' is reserved");
  }
  return name;
}

export function validateFocus(focus: string | null | undefined): string {
  const text = (focus ?? "").trim();
  if (text.length > FOCUS_MAX) {
    throw new AgentValidationError(`focus must be at most ${FOCUS_MAX} characters`);
  }
  return text;
}

export function validateWakeTriggers(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (text.length > WAKE_TRIGGERS_MAX) {
    throw new AgentValidationError(`wake_triggers must be at most ${WAKE_TRIGGERS_MAX} characters`);
  }
  return text;
}

export function validateAvatarShape(value: string | null | undefined): string {
  const shape = normalizeAvatarShape(value);
  if (shape === null) {
    throw new AgentValidationError(
      "avatar_shape must be 1-63 lowercase letters, digits, colons, or hyphens",
    );
  }
  return shape;
}

export function validateAvatarColor(value: string | null | undefined): string {
  const color = normalizeAvatarColor(value);
  if (color === null) {
    throw new AgentValidationError("avatar_color must be a 6-digit hex color");
  }
  return color;
}
