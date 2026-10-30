import type { ReactNode } from "react";

type GuildPageProps = { children: ReactNode };

/** A guild page under the header and tabs: it scrolls on its own. */
export function GuildPage({ children }: GuildPageProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-5">{children}</div>
    </div>
  );
}
