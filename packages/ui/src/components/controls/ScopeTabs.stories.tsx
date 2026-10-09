import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScopeTabs } from "./ScopeTabs";
import { TabsContent } from "./Tabs";

const meta: Meta<typeof ScopeTabs> = {
  title: "Components/Controls/ScopeTabs",
  component: ScopeTabs,
};
export default meta;

type Story = StoryObj<typeof ScopeTabs>;

const noteScopes = [
  { value: "agent", label: "Agent", count: 1 },
  { value: "guild", label: "Guild", count: 2 },
  { value: "org", label: "Org", count: 0 },
];

const files: Record<string, string[]> = {
  agent: ["process.md"],
  guild: ["research_log.md", "watchlist.md"],
  org: [],
};

export const NoteScopes: Story = {
  render: () => (
    <div className="rounded-2xl bg-paper p-5">
      <ScopeTabs label="Note scope" scopes={noteScopes} defaultValue="agent">
        {noteScopes.map((scope) => (
          <TabsContent key={scope.value} value={scope.value} className="flex flex-col gap-1 px-1">
            {files[scope.value]?.length ? (
              files[scope.value]?.map((file) => (
                <span key={file} className="font-mono text-sm text-fg">
                  {file}
                </span>
              ))
            ) : (
              <span className="text-sm text-muted">No notes at this scope yet.</span>
            )}
          </TabsContent>
        ))}
      </ScopeTabs>
    </div>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="max-w-80 rounded-xl bg-surface p-6">
      <ScopeTabs label="Note scope" scopes={noteScopes} defaultValue="guild">
        {noteScopes.map((scope) => (
          <TabsContent
            key={scope.value}
            value={scope.value}
            className="px-1 font-mono text-sm text-fg"
          >
            {files[scope.value]?.[0] ?? "—"}
          </TabsContent>
        ))}
      </ScopeTabs>
    </div>
  ),
};
