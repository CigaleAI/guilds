import type { Meta, StoryObj } from "@storybook/react-vite";
import { AtSign } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../primitives/Icon";
import { TextField } from "./TextField";

const meta: Meta<typeof TextField> = {
  title: "Components/Controls/TextField",
  component: TextField,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof TextField>;

export const Basic: Story = {
  render: () => (
    <>
      <TextField label="Name" defaultValue="Degen-capital" />
      <TextField
        label="Max turns"
        mono
        type="number"
        min={1}
        defaultValue="200"
        hint="Consecutive agent messages in group chat before a user reply is required."
      />
      <TextField
        label="Max tokens"
        mono
        type="number"
        min={1}
        defaultValue="8192"
      />
    </>
  ),
};

function Counted() {
  const [about, setAbout] = useState("Degen trading firm. Memecoins and NFTs.");
  return (
    <TextField
      label="Short description"
      value={about}
      onChange={(event) => setAbout(event.currentTarget.value)}
      maxLength={200}
      showCount
      hint="Shown in the guild header and to agents."
    />
  );
}

export const WithCount: Story = { render: () => <Counted /> };

export const Invalid: Story = {
  render: () => (
    <>
      <TextField
        label="Handle"
        mono
        lead={<Icon icon={AtSign} size={14} />}
        defaultValue="wallet"
        error="Already taken in this guild"
      />
      <TextField
        label="Max agents"
        mono
        type="number"
        defaultValue="0"
        error="At least 1 — Degen-capital already has 4 agents."
        hint="Default 5."
      />
    </>
  ),
};

export const Shapes: Story = {
  render: () => (
    <>
      <TextField label="Box" placeholder="researcher" />
      <TextField shape="pill" aria-label="Pill" placeholder="Pill field" />
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs text-muted">meta_slug</span>
        <TextField
          shape="compact"
          aria-label="meta_slug contains"
          placeholder="contains"
          className="flex-1"
        />
      </div>
      <TextField label="Disabled" defaultValue="org-wide" disabled />
    </>
  ),
};
