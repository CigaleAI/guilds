import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TooltipProvider } from "../overlays/Tooltip";
import { Composer } from "./Composer";

const meta: Meta<typeof Composer> = { title: "Components/Controls/Composer", component: Composer };
export default meta;

type Story = StoryObj<typeof Composer>;

function AgentChat({ generating: initial }: { generating: boolean }) {
  const [generating, setGenerating] = useState(initial);
  return (
    <Composer
      label="Message managooor"
      placeholder="Send a message to managooor…"
      generating={generating}
      onCancel={() => setGenerating(false)}
      onSend={() => setGenerating(true)}
    />
  );
}

export const Inspector: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-2xl bg-paper p-7">
      <AgentChat generating={false} />
      <AgentChat generating />
    </div>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="flex max-w-80 flex-col gap-4 rounded-xl bg-surface p-6">
      <Composer
        tone="paper"
        label="Message managooor"
        placeholder="Send a message to managooor…"
        onSend={() => {}}
      />
      <Composer
        tone="paper"
        label="Message managooor"
        placeholder="Send a message to managooor…"
        generating
        onCancel={() => {}}
        onSend={() => {}}
      />
    </div>
  ),
};

export const WithText: Story = {
  render: () => (
    <div className="rounded-2xl bg-paper p-7">
      <Composer
        label="Message managooor"
        placeholder="Send a message to managooor…"
        defaultValue={
          "Every 24h, do a retrospective of the day.\nAsk researchoor to check the status of previous closed and exited calls,\nsee how your decisions held up, and fold the learnings into the fund thesis."
        }
        onSend={() => {}}
      />
    </div>
  ),
};

export const StudioCoach: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-6">
      <Composer
        tone="paper"
        label="Ask the coach"
        placeholder="Ask the coach about this guild, an agent, or the pinned item…"
        footnote="Selected evidence is sent to the resolved model provider and may contain pasted sensitive text."
        onSend={() => {}}
      />
    </div>
  ),
};

export const GroupChat: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-2xl bg-paper p-7">
      <Composer
        variant="inline"
        label="Message the guild"
        placeholder="Message the guild — type @ to mention an agent"
        onSend={() => {}}
      />
      <Composer
        variant="inline"
        label="Message the guild"
        placeholder="Message the guild — type @ to mention an agent"
        defaultValue="@managooor hold every BUY until WALLET_KEY is set."
        onSend={() => {}}
      />
      <div className="rounded-xl bg-surface p-6">
        <Composer
          variant="inline"
          tone="paper"
          label="Ask the planner"
          placeholder="Ask the planner to…"
          onSend={() => {}}
        />
      </div>
    </div>
  ),
};

export const Attachments: Story = {
  render: () => (
    <TooltipProvider>
      <div className="flex flex-col gap-4 rounded-2xl bg-paper p-7">
        <Composer
          label="Message managooor"
          placeholder="Send a message to managooor…"
          acceptAttachments
          onSend={() => {}}
        />
        <Composer
          label="Message qwen"
          placeholder="Send a message to qwen…"
          attachmentsUnavailable="Qwen3.8 does not accept images"
          onSend={() => {}}
        />
      </div>
    </TooltipProvider>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="rounded-2xl bg-paper p-7">
      <Composer
        disabled
        label="Message managooor"
        placeholder="This run has ended. Start a new run to continue."
        onSend={() => {}}
      />
    </div>
  ),
};

/** Type `@` to see the suggestions; arrows move, Enter or Tab picks, Escape dismisses. */
export const Mentions: Story = {
  render: () => (
    <div className="flex h-80 flex-col justify-end rounded-xl bg-paper p-6">
      <Composer
        variant="inline"
        label="Message Degen-capital"
        placeholder="Message the guild — type @ to mention an agent"
        onSend={() => {}}
        mentions={[
          { name: "skyzo", tone: "signal" },
          { name: "researchoor", tone: "moss" },
          { name: "wallet", tone: "tide" },
          { name: "managooor", tone: "rosewood" },
          { name: "user", hint: "every operator" },
        ]}
      />
    </div>
  ),
};
