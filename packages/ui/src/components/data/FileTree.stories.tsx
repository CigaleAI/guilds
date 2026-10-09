import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { FileTree, type FileTreeNode } from "./FileTree";

const meta: Meta<typeof FileTree> = {
  title: "Components/Data/FileTree",
  component: FileTree,
};
export default meta;

type Story = StoryObj<typeof FileTree>;

const noteNames = ["research_log.md", "sources.md", "scoring_rubric.md", "open_questions.md"];

const agentNotes: FileTreeNode[] = noteNames.map((name) => ({ id: name, name, kind: "file" }));

function Demo() {
  const [selected, setSelected] = useState("research_log.md");
  return (
    <FileTree
      label="Agent notes"
      nodes={agentNotes}
      selectedId={selected}
      onSelect={(node) => setSelected(node.id)}
    />
  );
}

export const OnSurface: Story = {
  render: () => (
    <div className="max-w-xs rounded-xl bg-surface p-6">
      <Demo />
    </div>
  ),
};

export const OnPaper: Story = {
  render: () => (
    <div className="max-w-64 rounded-xl bg-paper p-3">
      <Demo />
    </div>
  ),
};

const folders: FileTreeNode[] = [
  {
    id: "desk",
    name: "desk",
    kind: "folder",
    count: 3,
    children: [
      { id: "desk/playbook.md", name: "playbook.md", kind: "file" },
      { id: "desk/scoring_rubric.md", name: "scoring_rubric.md", kind: "file" },
      {
        id: "desk/theses",
        name: "theses",
        kind: "folder",
        count: 2,
        children: [
          { id: "desk/theses/stock-paired-memes.md", name: "stock-paired-memes.md", kind: "file" },
          { id: "desk/theses/rh-nft-mint-szn.md", name: "rh-nft-mint-szn.md", kind: "file" },
        ],
      },
    ],
  },
  { id: "watchlist.md", name: "watchlist.md", kind: "file" },
];

function Nested() {
  const [selected, setSelected] = useState<string | null>("desk/theses/stock-paired-memes.md");
  return (
    <FileTree
      label="Files in folders"
      nodes={folders}
      selectedId={selected}
      onSelect={(node) => setSelected(node.id)}
      defaultExpandedIds={["desk", "desk/theses"]}
    />
  );
}

export const NestedFolders: Story = {
  render: () => (
    <div className="max-w-xs rounded-xl bg-surface p-6">
      <Nested />
    </div>
  ),
};
