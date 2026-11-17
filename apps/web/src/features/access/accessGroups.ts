import type { AccessEntry, AccessList } from "../../api/types/access";

/** An item's access list as a list grouped by access has read it so far. */
export type AccessRead =
  { status: "pending" } | { status: "error" } | { status: "success"; list: AccessList };

/** Why items are listed together: a subject a row gives read or write, or what is known instead. */
export type AccessGroupKind = "org" | "guild" | "agents" | "unknown" | "pending" | "error";

export type AccessGroup<Item> = {
  /** Unique among the groups: the kind, and a guild's id for a guild's group. */
  key: string;
  kind: AccessGroupKind;
  label: string;
  items: Item[];
};

const kindLabels: Record<Exclude<AccessGroupKind, "guild">, string> = {
  org: "Organisation",
  agents: "Individual agents",
  unknown: "Access not fully known",
  pending: "Reading access",
  error: "Couldn't read access",
};

/** The kinds after the guilds' groups, in the order the list shows them. */
const trailingKinds = ["agents", "unknown", "pending", "error"] as const;

type Named = { id: string; name: string };

/** One group an item belongs in: a guild's, by its id and name, or one of the other kinds. */
type GroupMembership =
  | { kind: "guild"; guild: Named }
  | { kind: Exclude<AccessGroupKind, "guild">; guild?: undefined };

const byName = (a: Named, b: Named) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The groups an item's access read puts it in: one per subject a row gives read or write, the
 * organisation, each guild and individual agents together. A list with none, empty or of only
 * None rows, is not fully known: the rows of guilds the viewer cannot see are left out of it. A
 * read still running or failed is its own group, never taken for an empty list.
 */
function groupMemberships(read: AccessRead): GroupMembership[] {
  if (read.status !== "success") return [{ kind: read.status }];
  const granting = read.list.subjects.filter((entry) => entry.mode !== "none");
  if (!granting.length) return [{ kind: "unknown" }];
  const grants = (type: AccessEntry["type"]) => granting.filter((entry) => entry.type === type);
  return [
    ...(grants("org").length ? [{ kind: "org" as const }] : []),
    ...grants("guild").map((entry) => ({
      kind: "guild" as const,
      guild: { id: entry.id, name: entry.name },
    })),
    ...(grants("agent").length ? [{ kind: "agents" as const }] : []),
  ];
}

/**
 * The items by who their access lists reach: the organisation, each guild by name, individual
 * agents, then the items no row in sight grants, and those whose read is still running or failed.
 * An item is in every group it matches; a group keeps the items' order. Empty groups are left out.
 */
export function itemsByAccess<Item>(
  items: readonly Item[],
  readOf: (item: Item) => AccessRead,
): AccessGroup<Item>[] {
  const org: Item[] = [];
  const guilds = new Map<string, { name: string; items: Item[] }>();
  const trailing = new Map<AccessGroupKind, Item[]>(trailingKinds.map((kind) => [kind, []]));
  for (const item of items) {
    for (const { kind, guild } of groupMemberships(readOf(item))) {
      if (kind === "org") org.push(item);
      else if (guild) {
        const group = guilds.get(guild.id) ?? { name: guild.name, items: [] };
        group.items.push(item);
        guilds.set(guild.id, group);
      } else trailing.get(kind)?.push(item);
    }
  }
  const groups: AccessGroup<Item>[] = [
    { key: "org", kind: "org", label: kindLabels.org, items: org },
    ...[...guilds]
      .map(([id, group]) => ({ id, ...group }))
      .sort(byName)
      .map((group) => ({
        key: `guild:${group.id}`,
        kind: "guild" as const,
        label: `Guild · ${group.name}`,
        items: group.items,
      })),
    ...trailingKinds.map((kind) => ({
      key: kind,
      kind,
      label: kindLabels[kind],
      items: trailing.get(kind) ?? [],
    })),
  ];
  return groups.filter((group) => group.items.length);
}
