import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

export type TermListProps = Omit<ComponentProps<"ul">, "children"> & {
  terms: string[];
  /** Show at most this many; the rest collapse into a "+N" tag. */
  max?: number;
};

/** An array value in a record cell: each item a mono term tag, wrapping. */
export function TermList({ terms, max, className, ...props }: TermListProps) {
  const shown = max !== undefined ? terms.slice(0, max) : terms;
  const hidden = terms.length - shown.length;
  if (terms.length === 0) {
    return <span className="font-mono text-2xs text-faint">[]</span>;
  }
  return (
    <ul className={cn("flex min-w-0 flex-wrap gap-1", className)} {...props}>
      {shown.map((term, index) => (
        <li key={`${term}-${index}`} className="flex min-w-0">
          <Tag tone="term" className="max-w-full truncate">
            {term}
          </Tag>
        </li>
      ))}
      {hidden > 0 ? (
        <li className="flex">
          <Tag tone="well" title={terms.slice(shown.length).join(", ")}>
            +{hidden}
          </Tag>
        </li>
      ) : null}
    </ul>
  );
}
