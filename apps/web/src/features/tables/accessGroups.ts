import type { AccessList } from "../../api/types/access";
import type { Collection } from "../../api/types/tables";

/** A table's access list as the Tables list has read it so far. */
export type TableAccessRead =
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; list: AccessList };

/** Why tables are listed together: a subject a row gives read or write, or what is known instead. */
export type TableAccessGroupKind =
  | "org"
  | "guild"
  | "agents"
  | "unassigned"
  | "no_grant"
  | "unknown"
  | "pending"
  | "error";

export type TableAccessGroup = {
  /** Unique among the groups: the kind, and a guild's id for a guild's group. */
  key: string;
  kind: TableAccessGroupKind;
  label: string;
  tables: Collection[];
};

const kindLabels: Record<Exclude<TableAccessGroupKind, "guild">, string> = {
  org: "Organisation",
  agents: "Individual agents",
  unassigned: "No access assigned",
  no_grant: "No granting access",
  unknown: "Access not fully known",
  pending: "Reading access",
  error: "Couldn't read access",
};

/** The kinds after the guilds' groups, in the order the list shows them. */
const trailingKinds = ["agents", "unassigned", "no_grant", "unknown", "pending", "error"] as const;

/** One group a table belongs in: a guild's, by its id and name, or one of the other kinds. */
type GroupMembership =
  | { kind: "guild"; guild: { id: string; name: string } }
  | { kind: Exclude<TableAccessGroupKind, "guild">; guild?: undefined };

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The groups a table's access read puts it in: one per subject a row gives read or write, the
 * organisation, each guild and individual agents together; with none, an empty list or only None
 * rows when the list is known to be whole, else not fully known. A read still running or failed
 * is its own group, never taken for an empty list.
 */
function groupMemberships(read: TableAccessRead): GroupMembership[] {
  if (read.status !== "success") return [{ kind: read.status }];
  const { subjects, complete } = read.list;
  const granting = subjects.filter((entry) => entry.mode !== "none");
  if (!granting.length) {
    if (!complete) return [{ kind: "unknown" }];
    return [{ kind: subjects.length ? "no_grant" : "unassigned" }];
  }
  const memberships: GroupMembership[] = [];
  if (granting.some((entry) => entry.type === "org")) memberships.push({ kind: "org" });
  for (const entry of granting) {
    if (entry.type === "guild") memberships.push({ kind: "guild", guild: { id: entry.id, name: entry.name } });
  }
  if (granting.some((entry) => entry.type === "agent")) memberships.push({ kind: "agents" });
  return memberships;
}

/**
 * The tables by who their access lists reach, as the list shows them while a table's Access tab
 * is open: the organisation, each guild by name, individual agents, then the tables no row grants
 * and those whose access is unknown, still read or failed. A table is in every group it matches;
 * tables in a group are by name. Empty groups are left out.
 */
export function tablesByAccess(
  tables: readonly Collection[],
  readOf: (tableId: string) => TableAccessRead,
): TableAccessGroup[] {
  const org: Collection[] = [];
  const guilds = new Map<string, { name: string; tables: Collection[] }>();
  const trailing = new Map<TableAccessGroupKind, Collection[]>(trailingKinds.map((kind) => [kind, []]));
  for (const table of [...tables].sort(byName)) {
    for (const { kind, guild } of groupMemberships(readOf(table.id))) {
      if (kind === "org") org.push(table);
      else if (guild) {
        const group = guilds.get(guild.id) ?? { name: guild.name, tables: [] };
        group.tables.push(table);
        guilds.set(guild.id, group);
      } else trailing.get(kind)?.push(table);
    }
  }
  const groups: TableAccessGroup[] = [
    { key: "org", kind: "org", label: kindLabels.org, tables: org },
    ...[...guilds]
      .map(([id, group]) => ({ id, ...group }))
      .sort(byName)
      .map((group) => ({
        key: `guild:${group.id}`,
        kind: "guild" as const,
        label: `Guild · ${group.name}`,
        tables: group.tables,
      })),
    ...trailingKinds.map((kind) => ({
      key: kind,
      kind,
      label: kindLabels[kind],
      tables: trailing.get(kind) ?? [],
    })),
  ];
  return groups.filter((group) => group.tables.length);
}
