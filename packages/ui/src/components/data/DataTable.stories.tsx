import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyRound, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../cn";
import { identityText, type IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import { Avatar } from "../identity/Avatar";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../overlays/Menu";
import { BoolCell } from "./BoolCell";
import { DataTable, type DataTableColumn, type DataTableSort } from "./DataTable";
import { EnumBadge, type EnumBadgeTone } from "./EnumBadge";
import { IdCell } from "./IdCell";
import { TermList } from "./TermList";

const meta: Meta<typeof DataTable> = {
  title: "Components/Data/DataTable",
  component: DataTable,
};
export default meta;

type Story = StoryObj<typeof DataTable>;

type MetaRecord = {
  id: number;
  slug: string;
  description: string;
  terms: string[];
  stage: "mooning" | "nascent" | "fading";
  active: boolean;
  updated: string;
};

const records: MetaRecord[] = [
  {
    id: 1,
    slug: "robinhood-chain-szn",
    description: "Robinhood Chain (RH) has become the dominant meme venue",
    terms: ["RH", "Robinhood Chain", "stock-paired memes", "Pons"],
    stage: "mooning",
    active: true,
    updated: "2d ago",
  },
  {
    id: 2,
    slug: "ai-muse-social",
    description: "AI-agent social network meta: agents posting as muses",
    terms: ["musebook", "agrippa", "AI muses"],
    stage: "nascent",
    active: true,
    updated: "2d ago",
  },
  {
    id: 3,
    slug: "stock-paired-memes",
    description: "Memecoins paired with or themed on tokenized stocks",
    terms: ["4STOCK", "CASHCAT", "tokenized stocks"],
    stage: "nascent",
    active: true,
    updated: "3d ago",
  },
  {
    id: 4,
    slug: "stonk-fun",
    description: "stonk.fun on Solana: launchpad for stock-themed tokens",
    terms: ["STONK", "stonk.fun", "SPCX"],
    stage: "mooning",
    active: true,
    updated: "1d ago",
  },
  {
    id: 5,
    slug: "grokification-pfp",
    description: "Grok Bot-style PFP visual meta",
    terms: ["GROK", "grokify", "pfp cult"],
    stage: "fading",
    active: false,
    updated: "5d ago",
  },
  {
    id: 6,
    slug: "rh-nft-mint-szn",
    description: "Wave of NFT mints on Robinhood Chain",
    terms: ["RH MACHINES", "Kageuri", "Lost Otters", "Pixel Theory"],
    stage: "nascent",
    active: true,
    updated: "4d ago",
  },
];

const stageTone: Record<MetaRecord["stage"], EnumBadgeTone> = {
  mooning: "signal",
  nascent: "sand",
  fading: "plum",
};

const recordColumns: DataTableColumn<MetaRecord>[] = [
  { id: "id", header: "id", sortable: true, className: "w-16", cell: (row) => <IdCell value={row.id} /> },
  {
    id: "meta_slug",
    header: "meta_slug",
    sortable: true,
    className: "w-52",
    cell: (row) => <span className="font-semibold whitespace-nowrap">{row.slug}</span>,
  },
  {
    id: "description",
    header: "description",
    className: "max-w-64",
    cell: (row) => <span className="block truncate text-fg-2">{row.description}</span>,
  },
  { id: "related_terms", header: "related_terms", className: "w-64", cell: (row) => <TermList terms={row.terms} /> },
  {
    id: "stage",
    header: "stage",
    sortable: true,
    cell: (row) => <EnumBadge tone={stageTone[row.stage]}>{row.stage}</EnumBadge>,
  },
  { id: "active_monitoring", header: "active_monitoring", cell: (row) => <BoolCell value={row.active} /> },
  {
    id: "updated",
    header: "updated",
    cell: (row) => <span className="font-mono text-xs whitespace-nowrap text-muted">{row.updated}</span>,
  },
];

function sortRecords(rows: MetaRecord[], sort: DataTableSort | null): MetaRecord[] {
  if (!sort) return rows;
  const pick = (row: MetaRecord): string | number =>
    sort.columnId === "id" ? row.id : sort.columnId === "stage" ? row.stage : row.slug;
  const sorted = [...rows].sort((left, right) => (pick(left) < pick(right) ? -1 : pick(left) > pick(right) ? 1 : 0));
  return sort.direction === "ascending" ? sorted : sorted.reverse();
}

function RecordsDemo() {
  const [sort, setSort] = useState<DataTableSort | null>({ columnId: "id", direction: "ascending" });
  const [selected, setSelected] = useState<string | null>("3");
  const rows = useMemo(() => sortRecords(records, sort), [sort]);
  return (
    <DataTable
      label="degen-meta records"
      columns={recordColumns}
      rows={rows}
      getRowKey={(row) => String(row.id)}
      sort={sort}
      onSortChange={setSort}
      onRowClick={(row) => setSelected(String(row.id))}
      selectedKey={selected}
      tableClassName="min-w-240"
      className="max-h-96 rounded-xl"
    />
  );
}

export const Records: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <RecordsDemo />
    </div>
  ),
};

type Secret = {
  name: string;
  scope: "org" | "guild" | "agent";
  owner?: string;
  description: string;
  updated: string;
};

const secrets: Secret[] = [
  { name: "ALCHEMY_KEY", scope: "org", description: "Alchemy API key for NFT and balance reads", updated: "Sep 12" },
  { name: "CIGALE_TOKEN", scope: "guild", description: "Cigale workspace token for reply drafting", updated: "Sep 20" },
  { name: "WALLET_KEY", scope: "guild", description: "Treasury wallet private key; wallet signs orders", updated: "Sep 24" },
  {
    name: "COINGECKO_KEY",
    scope: "agent",
    owner: "wallet",
    description: "CoinGecko Pro key for price feeds",
    updated: "Sep 25",
  },
  { name: "X_SESSION", scope: "agent", owner: "skyzo", description: "X session cookie for the scout account", updated: "Sep 26" },
];

function SecretActions({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="outline" size="xs">
        <Icon icon={KeyRound} size={14} />
        Replace value
      </Button>
      <Menu>
        <MenuTrigger label={`More for ${name}`} variant="ghost" size={28} />
        <MenuContent>
          <MenuItem icon={Trash2} destructive>
            Delete {name}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

const secretColumns: DataTableColumn<Secret>[] = [
  {
    id: "name",
    header: "name",
    sortable: true,
    cell: (row) => <span className="font-mono text-sm whitespace-nowrap">{row.name}</span>,
  },
  {
    id: "scope",
    header: "scope",
    cell: (row) => <Tag tone="term">{row.owner ? `${row.scope} · ${row.owner}` : row.scope}</Tag>,
  },
  {
    id: "description",
    header: "description",
    className: "min-w-60",
    cell: (row) => <span className="text-fg-2">{row.description}</span>,
  },
  {
    id: "updated",
    header: "updated",
    sortable: true,
    cell: (row) => <span className="font-mono text-xs whitespace-nowrap text-muted">{row.updated}</span>,
  },
  { id: "actions", header: <span className="sr-only">Actions</span>, align: "end", cell: (row) => <SecretActions name={row.name} /> },
];

function SecretsDemo() {
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const rows = useMemo(() => {
    if (!sort) return secrets;
    const key = sort.columnId === "updated" ? "updated" : "name";
    const sorted = [...secrets].sort((left, right) => left[key].localeCompare(right[key]));
    return sort.direction === "ascending" ? sorted : sorted.reverse();
  }, [sort]);
  return (
    <DataTable
      label="Secrets"
      columns={secretColumns}
      rows={rows}
      getRowKey={(row) => row.name}
      sort={sort}
      onSortChange={setSort}
      tableClassName="min-w-200"
      className="rounded-xl"
    />
  );
}

export const SecretsTable: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <SecretsDemo />
    </div>
  ),
};

type AgentUsage = { name: string; tone: IdentityTone; wakes: number; tokens: string; cost: string; share: number };

const usage: AgentUsage[] = [
  { name: "wallet", tone: "tide", wakes: 624, tokens: "2.1M", cost: "$9.40", share: 23 },
  { name: "researchoor", tone: "moss", wakes: 402, tokens: "4.4M", cost: "$17.60", share: 43 },
  { name: "skyzo", tone: "signal", wakes: 214, tokens: "2.2M", cost: "$8.80", share: 21 },
  { name: "managooor", tone: "rosewood", wakes: 44, tokens: "1.1M", cost: "$5.40", share: 13 },
];

const shareFill: Record<IdentityTone, string> = {
  signal: "bg-id-signal",
  tide: "bg-id-tide",
  moss: "bg-id-moss",
  ochre: "bg-id-ochre",
  rosewood: "bg-id-rosewood",
  dusk: "bg-id-dusk",
};

const usageColumns: DataTableColumn<AgentUsage>[] = [
  {
    id: "agent",
    header: "agent",
    cell: (row) => (
      <span className="inline-flex items-center gap-2">
        <Avatar name={row.name} tone={row.tone} size={24} />
        <span className={cn("font-mono text-sm font-medium", identityText[row.tone])}>{row.name}</span>
      </span>
    ),
  },
  { id: "wakes", header: "wakes", align: "end", cell: (row) => <span className="font-mono text-xs">{row.wakes}</span> },
  { id: "tokens", header: "tokens", align: "end", cell: (row) => <span className="font-mono text-xs">{row.tokens}</span> },
  { id: "cost", header: "cost", align: "end", cell: (row) => <span className="font-mono text-xs">{row.cost}</span> },
  {
    id: "share",
    header: "share",
    className: "w-32",
    cell: (row) => (
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-well" aria-label={`${row.share}%`} role="img">
        <span className={cn("block h-full rounded-full", shareFill[row.tone])} style={{ width: `${row.share}%` }} />
      </span>
    ),
  },
];

export const UsageByAgent: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-6">
      <DataTable
        label="Usage by agent"
        columns={usageColumns}
        rows={usage}
        getRowKey={(row) => row.name}
        className="rounded-lg"
      />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <DataTable
        label="degen-orders records"
        columns={recordColumns}
        rows={[]}
        getRowKey={(row) => String(row.id)}
        empty="No records match “stonk”."
        className="rounded-xl"
      />
    </div>
  ),
};

export const OnSurfaceTone: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-paper p-6">
      <DataTable
        label="Usage by agent"
        tone="surface"
        columns={usageColumns}
        rows={usage}
        getRowKey={(row) => row.name}
        onRowClick={() => {}}
        selectedKey="researchoor"
        className="rounded-lg"
      />
    </div>
  ),
};
