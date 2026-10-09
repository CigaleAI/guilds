import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown } from "lucide-react";
import { Button } from "../components/actions/Button";
import { Card, CardBody, CardFooter, CardHeader, CardStack, CardStackItem } from "./Card";
import { Icon } from "./Icon";
import { Tag } from "./Tag";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
  decorators: [
    (Story) => (
      <div className="max-w-sm rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Card>;

export const HeaderBodyFooter: Story = {
  render: (args) => (
    <Card {...args}>
      <CardHeader title="header · title" meta={<Tag tone="surface">meta</Tag>} />
      <CardBody>body · any stack of rows / text / viz</CardBody>
      <CardFooter>
        <Button variant="outline" size="sm">
          Secondary
        </Button>
        <Button size="sm">Primary</Button>
      </CardFooter>
    </Card>
  ),
};

export const Collapsible: Story = {
  render: () => (
    <Card>
      <CardHeader title="Offered tools" meta={<Tag tone="signal">54 available</Tag>} trail={<Icon icon={ChevronDown} />} />
    </Card>
  ),
};

export const Stacked: Story = {
  render: () => (
    <CardStack>
      <CardStackItem level={0} tone="panel" className="px-3.5 py-3 text-xs">
        stacked · front
      </CardStackItem>
      <CardStackItem level={1} tone="plum" className="px-3.5 pb-2.5 text-xs">
        stacked · tucked behind
      </CardStackItem>
      <CardStackItem level={2} tone="signal" className="px-3.5 pb-2.5 text-xs">
        stacked · third
      </CardStackItem>
    </CardStack>
  ),
};
