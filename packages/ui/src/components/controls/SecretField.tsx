import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../actions/IconButton";
import { TextField, type TextFieldProps } from "./TextField";

export type SecretFieldProps = Omit<TextFieldProps, "type" | "trail">;

/** A labelled password input with a button that shows and hides what was typed: keys, tokens. */
export function SecretField({ autoComplete = "off", ...props }: SecretFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...props}
      type={shown ? "text" : "password"}
      autoComplete={autoComplete}
      spellCheck={false}
      trail={
        <IconButton
          icon={shown ? EyeOff : Eye}
          label={shown ? "Hide value" : "Show value"}
          aria-pressed={shown}
          variant="ghost"
          size={24}
          round
          className="-mr-2 text-muted hover:text-fg"
          onClick={() => setShown((current) => !current)}
        />
      }
    />
  );
}
