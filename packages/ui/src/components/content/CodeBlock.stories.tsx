import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodeBlock } from "./CodeBlock";

const script = `"""Score watchlist posts; write keepers to Replies."""
from guilds import tables, x

def run(since="2h", threshold=0.72):
    posts = x.watchlist(since=since)
    keep = [p for p in posts if score(p) >= threshold]
    tables.Replies.insert(keep, status="scored")
    return len(keep)
`;

const schema = `{
  "type": "object",
  "properties": {
    "since": { "type": "string", "default": "2h" },
    "threshold": { "type": "number", "default": 0.72 },
    "dry_run": { "type": "boolean", "default": false }
  },
  "required": ["since"]
}`;

const meta: Meta<typeof CodeBlock> = {
  title: "Components/Content/CodeBlock",
  component: CodeBlock,
  args: { code: script, language: "python", lineNumbers: true },
};
export default meta;

type Story = StoryObj<typeof CodeBlock>;

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-2xl rounded-xl bg-paper p-6">
      <CodeBlock {...args} />
    </div>
  ),
};

/** A script on its card: the block runs edge to edge under the description. */
export const PythonFile: Story = {
  render: () => (
    <div className="max-w-2xl overflow-hidden rounded-xl bg-paper">
      <div className="px-4 pt-3.5 pb-3">
        <span className="font-mono text-md font-semibold">score_posts.py</span>
        <p className="mt-1 text-sm text-fg-2">
          Fetches the watchlist since a given time, scores each post 0–1 for reply-worthiness and
          writes the ones above threshold to Replies.
        </p>
      </div>
      <CodeBlock code={script} language="python" lineNumbers className="rounded-none" />
      <div className="flex justify-between px-4 py-2.5 font-mono text-2xs text-muted">
        <span>/home/agent/scripts/score_posts.py</span>
        <span>python · sandboxed in scout's workspace</span>
      </div>
    </div>
  ),
};

export const CompactJson: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-surface p-6">
      <CodeBlock code={schema} language="json" density="compact" />
    </div>
  ),
};

export const PlainText: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-surface p-6">
      <CodeBlock code={"$ python score_posts.py\n14 rows\n"} copy={false} density="compact" />
    </div>
  ),
};
