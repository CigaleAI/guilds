import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Calendar,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileText,
  Filter,
  Folder,
  Globe,
  History,
  Inbox,
  Lock,
  Maximize2,
  MessageSquare,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { Icon, type IconSize } from "../primitives/Icon";
import { Surface } from "../primitives/Surface";
import { Text } from "../primitives/Text";

const meta: Meta = {
  title: "Foundations",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

function Page({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col gap-6 bg-page p-8">{children}</div>;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Surface tone="surface" className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <Text variant="title">{title}</Text>
        {note ? <Text variant="caption">{note}</Text> : null}
      </div>
      {children}
    </Surface>
  );
}

const colourGroups: { name: string; tokens: [string, string][] }[] = [
  {
    name: "Grounds",
    tokens: [
      ["page", "app background"],
      ["well", "tracks · wells · frames"],
      ["surface", "cards"],
      ["paper", "inputs · rows on cards"],
      ["paper-hi", "hover on paper"],
      ["stripe", "zebra lanes"],
    ],
  },
  {
    name: "Lines",
    tokens: [
      ["line", "hairline on paper"],
      ["line-2", "hairline on surface"],
      ["line-3", "divider on well"],
      ["rule", "idle marks · off track"],
      ["rule-2", "checkbox · dashed"],
    ],
  },
  {
    name: "Text",
    tokens: [
      ["fg", "primary text"],
      ["fg-2", "body"],
      ["muted", "meta · captions"],
      ["faint", "disabled only"],
    ],
  },
  {
    name: "Inverse and panel",
    tokens: [
      ["ink-fill", "primary button · selected tab"],
      ["on-ink", "text on ink-fill"],
      ["on-ink-muted", "meta on ink-fill"],
      ["panel", "code · traces · toasts"],
      ["on-panel", "text on panel"],
      ["on-panel-muted", "meta on panel"],
    ],
  },
  {
    name: "Fills",
    tokens: [
      ["signal", "live · posted · accent action"],
      ["signal-2", "identity · records"],
      ["mauve", "running mark · identity"],
      ["tide", "success fill · identity"],
      ["dusk", "queued · capacity"],
      ["plum", "blocker · selected · human"],
      ["ochre", "warning fill"],
    ],
  },
  {
    name: "On fill",
    tokens: [
      ["on-signal", "on signal · signal-2 · mauve"],
      ["on-plum", "on plum · dusk · tide"],
      ["on-plum-muted", "meta on deep fills"],
      ["on-ochre", "on ochre"],
    ],
  },
  {
    name: "Accent text",
    tokens: [
      ["signal-t", "cyan as text on light"],
      ["tide-t", "success text"],
      ["plum-t", "danger · mention text"],
      ["dusk-t", "dusk text"],
      ["signal-soft", "cyan on plum / panel"],
      ["plum-soft", "failure on plum / panel"],
    ],
  },
  {
    name: "Tints",
    tokens: [
      ["t-sig", "running · read"],
      ["t-sig-fg", "on t-sig"],
      ["t-tide", "success · ok"],
      ["t-tide-fg", "on t-tide"],
      ["t-plum", "blocked · write"],
      ["t-dusk-fg", "queued text"],
      ["t-ochre", "warning · pending"],
      ["t-ochre-fg", "on t-ochre"],
    ],
  },
  {
    name: "Identity",
    tokens: [
      ["id-signal", "agent colour · name in id-signal-t"],
      ["id-tide", "agent colour · name in id-tide-t"],
      ["id-moss", "agent colour · name in id-moss-t"],
      ["id-ochre", "agent colour · name in id-ochre-t"],
      ["id-rosewood", "agent colour · name in id-rosewood-t"],
      ["id-dusk", "agent colour · name in id-dusk-t"],
      ["on-id", "initials on every identity fill"],
    ],
  },
  {
    name: "Overlay",
    tokens: [
      ["on-signal-line", "dividers in cyan bands"],
      ["on-plum-track", "tracks on plum"],
      ["on-plum-hover", "buttons on plum"],
      ["scrim", "behind dialogs"],
      ["focus", "focus ring"],
    ],
  },
];

export const Colours: Story = {
  render: () => (
    <Page>
      <Section
        title="Colour tokens"
        note="Every colour in the product is one of these. Switch the theme in the toolbar to see them change."
      >
        {colourGroups.map((group) => (
          <div key={group.name} className="flex flex-col gap-2">
            <Text variant="label">{group.name}</Text>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
              {group.tokens.map(([token, use]) => (
                <div key={token} className="flex items-center gap-3 rounded-md bg-paper p-2">
                  <span
                    className="size-9 shrink-0 rounded-sm inset-ring inset-ring-line-3"
                    style={{ background: `var(--${token})` }}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs">--{token}</span>
                    <span className="truncate text-xs text-muted">{use}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>
    </Page>
  ),
};

const typeScale: [string, number, string][] = [
  ["2xs", 11, "meta · mono labels · tags"],
  ["xs", 12, "captions · pills"],
  ["sm", 13, "UI text · buttons · code"],
  ["md", 14, "body · table cells"],
  ["lg", 16, "card titles · lead"],
  ["xl", 18, "band values"],
  ["2xl", 20, "dialog titles"],
  ["3xl", 24, "screen titles"],
  ["4xl", 32, "page headers"],
  ["5xl", 48, "hero numbers"],
  ["6xl", 64, "display"],
];

const textStyles = [
  ["display", "73K"],
  ["hero", "128"],
  ["h1", "Degen-capital"],
  ["h2", "Guild overview"],
  ["title", "Offered tools"],
  ["body", "Fund stays flat until data recovers."],
  ["caption", "Active via guild · connected"],
  ["label", "Guilds"],
  ["code", "note_find"],
  ["meta", "run_8f2c · 1.2s"],
] as const;

export const Typography: Story = {
  render: () => (
    <Page>
      <Section title="Type scale" note="Eleven sizes, nothing in between. Minimum 11px.">
        <div className="flex flex-col">
          {typeScale.map(([name, px, use]) => (
            <div key={name} className="grid grid-cols-[96px_48px_1fr] items-baseline gap-3 border-b border-line-2 py-1.5">
              <span className="font-mono text-2xs text-muted">text-{name}</span>
              <span className="font-mono text-2xs text-muted">{px}</span>
              <span className="flex items-baseline gap-3" style={{ fontSize: px }}>
                Aa <span className="text-xs text-muted">{use}</span>
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Text styles" note="Size, line height, weight and tracking together; colour is separate.">
        <div className="flex flex-col">
          {textStyles.map(([variant, sample]) => (
            <div key={variant} className="grid grid-cols-[96px_1fr] items-baseline gap-3 border-b border-line-2 py-2">
              <span className="font-mono text-2xs text-muted">type-{variant}</span>
              <Text variant={variant} truncate as="span">
                {sample}
              </Text>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  ),
};

const spacing = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64];
const radii: [string, string, string][] = [
  ["2xs", "rounded-2xs", "2px · marks"],
  ["xs", "rounded-xs", "4px · bars · kbd · checkbox"],
  ["sm", "rounded-sm", "8px · tags · 24–28 tiles"],
  ["md", "rounded-md", "12px · rows · fields · 36 tiles"],
  ["lg", "rounded-lg", "16px · tables · menus · 44 tiles"],
  ["xl", "rounded-xl", "24px · cards · dialogs · 64 tiles"],
  ["2xl", "rounded-2xl", "32px · panels · app frame"],
  ["3xl", "rounded-3xl", "40px · page sections"],
  ["full", "rounded-full", "pills · dots"],
];

const elevations: [string, string, string][] = [
  ["pop", "shadow-pop", "menus · toasts · popovers"],
  ["float", "shadow-float", "app frames"],
  ["modal", "shadow-modal", "dialogs · sheets"],
];

export const SpaceRadiusElevation: Story = {
  name: "Space, radius and elevation",
  render: () => (
    <Page>
      <Section title="Spacing" note="A 4px grid with 2px half-steps below 16. Gap, padding and margin only use these.">
        <div className="flex flex-col gap-1">
          {spacing.map((px) => (
            <div key={px} className="flex items-center gap-3">
              <span className="w-8 font-mono text-2xs text-muted">{px}</span>
              <span className="h-2.5 rounded-xs bg-signal" style={{ width: px * 4 }} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Radius" note="Nine radii. Nested corners: inner = outer − padding.">
        <div className="flex flex-wrap gap-4">
          {radii.map(([name, radius, use]) => (
            <div key={name} className="flex w-32 flex-col gap-1.5">
              <span className={cn("h-14 bg-paper inset-ring-[1.5px] inset-ring-fg", radius)} />
              <span className="font-mono text-2xs">rounded-{name}</span>
              <span className="text-xs text-muted">{use}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Elevation" note="Depth comes from stacked colour first, shadow second.">
        <div className="flex flex-wrap gap-6 bg-surface p-4">
          {elevations.map(([name, shadow, use]) => (
            <div key={name} className="flex w-44 flex-col gap-2">
              <span className={cn("h-16 rounded-lg bg-paper", shadow)} />
              <span className="font-mono text-2xs">shadow-{name}</span>
              <span className="text-xs text-muted">{use}</span>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  ),
};

const icons: [string, LucideIcon][] = [
  ["search", Search],
  ["plus", Plus],
  ["x", X],
  ["chevron-down", ChevronDown],
  ["chevron-right", ChevronRight],
  ["arrow-up", ArrowUp],
  ["arrow-left", ArrowLeft],
  ["maximize-2", Maximize2],
  ["ellipsis", Ellipsis],
  ["refresh-cw", RefreshCw],
  ["download", Download],
  ["trash-2", Trash2],
  ["pencil", Pencil],
  ["copy", Copy],
  ["check", Check],
  ["circle-alert", CircleAlert],
  ["inbox", Inbox],
  ["sparkles", Sparkles],
  ["book-open", BookOpen],
  ["database", Database],
  ["file-text", FileText],
  ["folder", Folder],
  ["wrench", Wrench],
  ["lock", Lock],
  ["chart-column", ChartColumn],
  ["settings", Settings],
  ["calendar", Calendar],
  ["history", History],
  ["code", Code],
  ["globe", Globe],
  ["message-square", MessageSquare],
  ["terminal", Terminal],
  ["users", Users],
  ["panel-left", PanelLeft],
  ["play", Play],
  ["filter", Filter],
];

export const Icons: Story = {
  render: () => (
    <Page>
      <Section title="Icons" note="Lucide at a 1.5px stroke, 14 / 16 / 18 / 20 / 24, in the text colour.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {icons.map(([name, glyph]) => (
            <div key={name} className="flex flex-col items-center gap-1.5 rounded-md bg-paper px-2 py-3">
              <Icon icon={glyph} size={18} />
              <span className="font-mono text-2xs text-muted">{name}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4">
          {([14, 16, 18, 20, 24] as IconSize[]).map((size) => (
            <span key={size} className="flex items-center gap-1.5">
              <Icon icon={Sparkles} size={size} />
              <span className="font-mono text-2xs text-muted">{size}</span>
            </span>
          ))}
        </div>
      </Section>
    </Page>
  ),
};
