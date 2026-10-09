import { FileText } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";

export type FileRefProps = Omit<ComponentProps<"span">, "children"> & {
  /** Display path, such as `portfolio_valuation.md` or `notes/desk.md`. */
  path: string;
  /** Lead with a file glyph. */
  icon?: boolean;
  /** The ground one step off what it sits on: well inside a message, paper on surface. */
  tone?: "well" | "paper";
};

/** A file or note path mentioned inline. Long paths truncate; the full path is the tooltip. */
export function FileRef({ path, icon, tone = "well", className, ...props }: FileRefProps) {
  return (
    <Tag
      tone={tone}
      title={path}
      className={cn("min-w-0 align-baseline text-xs", className)}
      {...props}
    >
      {icon ? <Icon icon={FileText} size={14} className="text-muted" /> : null}
      <span className="min-w-0 truncate">{path}</span>
    </Tag>
  );
}
