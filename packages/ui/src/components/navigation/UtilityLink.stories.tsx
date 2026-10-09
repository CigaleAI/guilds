import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen, Database, Inbox, PenLine, Sparkles } from "lucide-react";
import { UtilityLink } from "./UtilityLink";

const meta: Meta<typeof UtilityLink> = {
  title: "Components/Navigation/UtilityLink",
  component: UtilityLink,
  args: {
    icon: Inbox,
    tone: "plum",
    title: "Inbox",
    subtitle: "Issues and tags for you",
    count: 26,
  },
  decorators: [
    (Story) => (
      <div className="flex w-75 flex-col gap-2 rounded-xl bg-surface p-4">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof UtilityLink>;

export const Playground: Story = {};

/** The roomy workspace-tool card, with a subtitle. */
export const Tools: Story = {
  render: () => (
    <>
      <UtilityLink
        icon={Inbox}
        tone="plum"
        title="Inbox"
        subtitle="Issues and tags for you"
        count={26}
      />
      <UtilityLink
        icon={PenLine}
        tone="tide-tint"
        title="Studio"
        subtitle="Design and improve prompts"
      />
      <UtilityLink
        icon={Sparkles}
        tone="signal"
        title="Builder"
        subtitle="Sentence to a guild recipe"
      />
      <UtilityLink
        icon={BookOpen}
        tone="plum-tint"
        title="Recipes"
        subtitle="Library, import, apply"
      />
      <UtilityLink
        icon={Database}
        tone="signal-tint"
        title="Databases"
        subtitle="Tables agents share"
        selected
      />
    </>
  ),
};

/** The title-only row the sidebar footer uses. */
export const Compact: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <UtilityLink density="compact" icon={Inbox} tone="plum" title="Inbox" count={26} />
      <UtilityLink density="compact" icon={PenLine} tone="tide-tint" title="Studio" />
      <UtilityLink density="compact" icon={Sparkles} tone="signal" title="Builder" />
      <UtilityLink density="compact" icon={BookOpen} tone="plum-tint" title="Recipes" />
      <UtilityLink
        density="compact"
        icon={Database}
        tone="signal-tint"
        title="Databases"
        selected
      />
    </div>
  ),
};
