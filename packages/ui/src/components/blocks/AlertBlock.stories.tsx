import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight } from "lucide-react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { AlertBlock } from "./AlertBlock";

const meta: Meta<typeof AlertBlock> = {
  title: "Components/Blocks/AlertBlock",
  component: AlertBlock,
  decorators: [
    (Story) => (
      <div className="max-w-4xl rounded-xl bg-paper p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AlertBlock>;

const actions = (size: "sm" | "md") => (
  <>
    <Button variant="on-plum" size={size}>
      Investigate
    </Button>
    <Button variant="accent" size={size}>
      Add secret
      <Icon icon={ArrowRight} size={14} />
    </Button>
  </>
);

export const MissingCredentials: Story = {
  args: {
    eyebrow: "Blocked · 3 runs",
    title: "Wallet credentials missing",
    description:
      "wallet and managooor can’t value the fund. No orders will execute until a key is added.",
    actions: actions("md"),
    stats: [
      { value: "03:00", label: "first failure (UTC)" },
      { value: "3 / 3", label: "hourly runs affected" },
      { value: "WALLET_KEY", label: "missing secret" },
    ],
  },
};

export const Compact: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    eyebrow: "Blocked · 3 runs",
    title: "Credentials missing",
    actions: actions("sm"),
    stats: [
      { value: "03:00", label: "since" },
      { value: "3 / 3", label: "runs" },
    ],
  },
};
