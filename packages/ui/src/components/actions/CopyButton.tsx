import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton, type IconButtonProps } from "./IconButton";

export type CopyButtonProps = Omit<IconButtonProps, "icon" | "label" | "onClick"> & {
  /** The text to copy, or a function that makes it when clicked. */
  text: string | (() => string);
  /** What is copied, such as "arguments"; the button reads "Copy arguments". */
  what?: string;
};

/** Copies text to the clipboard and shows a check for a moment. */
export function CopyButton({
  text,
  what,
  variant = "ghost",
  size = 28,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : `Copy${what ? ` ${what}` : ""}`}
      variant={variant}
      size={size}
      onClick={() => void copy()}
      {...props}
    />
  );
}
