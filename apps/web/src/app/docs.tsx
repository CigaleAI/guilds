import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "@guildsrun/ui";

const DOCS_ORIGIN = "https://docs.guilds.run";

/** A page of the public documentation, in a new tab; `path` is the page's path on the docs site. */
export function DocsLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={`${DOCS_ORIGIN}${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline"
    >
      {children}
      <Icon icon={ExternalLink} size={14} />
    </a>
  );
}
