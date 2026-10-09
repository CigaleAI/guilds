import type { ReactNode } from "react";
import { cn } from "@guildsrun/ui";

/**
 * The connector's mark, painted in the current text colour through its logo as a mask; null when
 * the connector has no logo and the card shows its initial.
 */
export function connectorLogo(logoUrl: string | null | undefined, className?: string): ReactNode {
  if (!logoUrl) return null;
  const mask = `url("${logoUrl}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-6 shrink-0 bg-current", className)}
      style={{ mask, WebkitMask: mask }}
    />
  );
}
