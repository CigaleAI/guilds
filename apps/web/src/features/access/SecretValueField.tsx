import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Icon, SecretField, type SecretFieldProps } from "@guildsrun/ui";
import { whitespaceNotes } from "./secrets";

export type SecretValueFieldProps = Omit<SecretFieldProps, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

function WhitespaceNote({ notes }: { notes: string[] }): ReactNode {
  return (
    <span className="flex items-start gap-1.5">
      <Icon icon={Info} size={14} className="mt-px shrink-0" />
      <span>{notes.join(" ")}</span>
    </span>
  );
}

/**
 * A secret's value field: hidden until its button shows it, with a note in place of the hint
 * while the value has whitespace, saying what saving does with it.
 */
export function SecretValueField({ value, onValueChange, hint, ...props }: SecretValueFieldProps) {
  const notes = whitespaceNotes(value);
  return (
    <SecretField
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      hint={notes.length ? <WhitespaceNote notes={notes} /> : hint}
    />
  );
}
