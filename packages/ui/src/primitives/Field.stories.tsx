import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUp, CircleAlert, Search } from "lucide-react";
import { IconButton } from "../components/actions/IconButton";
import { Field, FieldInput, FieldTextarea } from "./Field";
import { Icon } from "./Icon";

const meta: Meta<typeof Field> = {
  title: "Primitives/Field",
  component: Field,
  decorators: [
    (Story) => (
      <div className="flex max-w-sm flex-col gap-2 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Field>;

export const Shapes: Story = {
  render: () => (
    <>
      <Field shape="pill" lead={<Icon icon={Search} size={14} />}>
        <FieldInput placeholder="Pill field" aria-label="Pill field" />
      </Field>
      <Field shape="rounded" trail={<IconButton icon={ArrowUp} label="Send" variant="ink" />}>
        <FieldInput placeholder="Rounded field + trailing action" aria-label="Message" />
      </Field>
      <Field shape="area">
        <FieldTextarea rows={2} defaultValue="mono area" aria-label="Notes" />
      </Field>
      <Field shape="box">
        <FieldInput defaultValue="Daily retrospective" aria-label="Name" />
      </Field>
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs">meta_slug</span>
        <Field shape="compact" className="flex-1">
          <FieldInput placeholder="contains" aria-label="meta_slug contains" />
        </Field>
      </div>
    </>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Field shape="box" invalid>
        <FieldInput defaultValue="trench-intern" aria-label="Handle" aria-invalid />
      </Field>
      <span className="flex items-center gap-1.5 text-xs text-plum-t">
        <Icon icon={CircleAlert} size={14} /> Already taken in this guild
      </span>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Field shape="pill">
      <FieldInput disabled defaultValue="Read only" aria-label="Disabled" />
    </Field>
  ),
};
