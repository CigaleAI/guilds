import { useState } from "react";
import { identityHex, TextField } from "@guildsrun/ui";
import { liveHandleError } from "../names";
import { AvatarPicker } from "./settings/AvatarPicker";

/** The server's cap on an agent's focus. */
export const focusMax = 150;

export type Look = { shape: string; color: string };

export function freshLook(): Look {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const seed = Array.from(bytes, (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join(
    "",
  );
  return { shape: `critters:${seed}`, color: identityHex.signal };
}

/** A new agent's name, focus, and look as the create dialogs draft them. */
export type IdentityDraft = {
  name: string;
  focus: string;
  look: Look;
  /** Whether the name was typed or left, after which its errors show. */
  nameStarted: boolean;
};

export function emptyIdentity(): IdentityDraft {
  return { name: "", focus: "", look: freshLook(), nameStarted: false };
}

/** The name's error once the operator has started on it; nothing before. */
export function identityNameError(draft: IdentityDraft): string | undefined {
  return liveHandleError(draft.name, draft.nameStarted, "agent");
}

/** Whether the identity can be sent: a name without errors. */
export function identityComplete(draft: IdentityDraft): boolean {
  return Boolean(draft.name.trim()) && !liveHandleError(draft.name, true, "agent");
}

export function useIdentityDraft() {
  const [draft, setDraft] = useState<IdentityDraft>(emptyIdentity);
  return { draft, setDraft, reset: () => setDraft(emptyIdentity()) };
}

/** Name, focus, and avatar of a new agent. */
export function IdentityFields({
  draft,
  onChange,
}: {
  draft: IdentityDraft;
  onChange: (next: IdentityDraft) => void;
}) {
  const nameError = identityNameError(draft);
  return (
    <>
      <TextField
        tone="surface"
        label="Name"
        mono
        required
        autoFocus
        autoComplete="off"
        placeholder="researcher"
        hint="Other agents tag it with @name. You can change it later in Settings."
        value={draft.name}
        onChange={(event) =>
          onChange({ ...draft, name: event.currentTarget.value, nameStarted: true })
        }
        onBlur={() => onChange({ ...draft, nameStarted: true })}
        {...(nameError ? { error: nameError } : {})}
      />
      <TextField
        tone="surface"
        label="Focus"
        aside="optional"
        maxLength={focusMax}
        showCount
        placeholder="What this agent is for"
        hint="Other agents see it next to its name; it also starts its Task, which you write on the Prompt tab."
        value={draft.focus}
        onChange={(event) => onChange({ ...draft, focus: event.currentTarget.value })}
      />
      <AvatarPicker
        name={draft.name || "agent"}
        shape={draft.look.shape}
        color={draft.look.color}
        onChange={(look) => onChange({ ...draft, look })}
      />
    </>
  );
}
