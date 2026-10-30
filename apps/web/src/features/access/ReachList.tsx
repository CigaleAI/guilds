import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useReach } from "../../api/queries/access";
import type { AccessMode, ReachSubject, ReachedNote, ReachedTable } from "../../api/types";
import { Banner, SkeletonRows, Tag } from "@guildsrun/ui";
import { accessModeLabel } from "./accessList";
import { noteLink, notePlacement } from "./reach";

const intros: Record<ReachSubject["type"], string> = {
  guild:
    "The notes and tables every agent of this guild reaches through the rows of this guild and of the organisation. An agent's own row can widen or narrow it.",
  agent:
    "The notes and tables this agent reaches: its own notes, and every item whose access list gives it, its guild or the organisation a row.",
};

const editHint = "Change who reaches an item on the item: a table's Access tab, a note's Access.";

function ModeTag({ mode }: { mode: AccessMode }) {
  return (
    <Tag tone={mode === "write" ? "tide" : "signal"} font="sans">
      {accessModeLabel[mode]}
    </Tag>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="type-label text-muted">
        {title} · {count}
      </h3>
      {count ? (
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface">{children}</div>
      ) : (
        <p className="text-sm text-muted">None.</p>
      )}
    </section>
  );
}

const rowClass =
  "flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0";

function TableRow({ table }: { table: ReachedTable }) {
  return (
    <div className={rowClass}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/tables/$collectionId"
          params={{ collectionId: table.id }}
          search={{ tab: "access" }}
          className="w-fit font-mono text-sm font-medium hover:underline"
        >
          {table.name}
        </Link>
        <span className="truncate text-xs text-muted">
          {table.guild ? `Guild · ${table.guild.name}` : "Organisation"} · {table.purpose}
        </span>
      </div>
      <ModeTag mode={table.mode} />
    </div>
  );
}

function NoteTitle({ note, guildId }: { note: ReachedNote; guildId: string }) {
  const link = noteLink(note, guildId);
  const className = "w-fit font-mono text-sm font-medium hover:underline";
  if (!link) return <span className="font-mono text-sm font-medium">{note.title}</span>;
  if (link.agentId) {
    return (
      <Link
        to="/guilds/$guildId/agents/$agentId/state/notes"
        params={{ guildId: link.guildId, agentId: link.agentId }}
        search={{ path: link.path }}
        className={className}
      >
        {note.title}
      </Link>
    );
  }
  return (
    <Link
      to="/guilds/$guildId/state/notes"
      params={{ guildId: link.guildId }}
      search={{ path: link.path }}
      className={className}
    >
      {note.title}
    </Link>
  );
}

function NoteRow({ note, guildId }: { note: ReachedNote; guildId: string }) {
  return (
    <div className={rowClass}>
      <div className="flex min-w-0 flex-1 flex-col">
        <NoteTitle note={note} guildId={guildId} />
        <span className="truncate text-xs text-muted">{notePlacement(note)}</span>
      </div>
      <ModeTag mode={note.mode} />
    </div>
  );
}

/**
 * What a guild's agents, or one agent, reach: the notes and tables with the mode each ends up
 * with. Read-only; each item links to where its access list is edited.
 */
export function ReachList({ subject, guildId }: { subject: ReachSubject; guildId: string }) {
  const reach = useReach(subject);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-10 md:py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-5">
        <p className="text-sm text-fg-2">
          {intros[subject.type]} {editHint}
        </p>
        {reach.isPending ? (
          <SkeletonRows rows={4} label="Loading what it reaches" />
        ) : reach.isError ? (
          <Banner tone="error" title="Couldn't load what it reaches" meta={reach.error.message} />
        ) : (
          <>
            <Section title="Tables" count={reach.data.tables.length}>
              {reach.data.tables.map((table) => (
                <TableRow key={table.id} table={table} />
              ))}
            </Section>
            <Section title="Notes" count={reach.data.notes.length}>
              {reach.data.notes.map((note) => (
                <NoteRow key={note.id} note={note} guildId={guildId} />
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
