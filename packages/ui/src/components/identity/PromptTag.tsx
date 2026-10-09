import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

/** The four sections a system prompt is assembled from. */
export type PromptSection = "guidelines" | "task" | "state" | "memory";

/** The sections in the order every run's system message composes them. */
export const promptSections: readonly PromptSection[] = ["guidelines", "task", "state", "memory"];

const sectionTone = {
  guidelines: "signal",
  task: "plum",
  state: "tide",
  memory: "ochre",
} as const satisfies Record<PromptSection, string>;

export type PromptTagProps = Omit<ComponentProps<"span">, "children"> & {
  section: PromptSection;
};

/** A system-prompt section, written as its XML tag in the section's colour. */
export function PromptTag({ section, className, ...props }: PromptTagProps) {
  return (
    <Tag tone={sectionTone[section]} className={cn("align-baseline text-xs", className)} {...props}>
      {`<${section}>`}
    </Tag>
  );
}
