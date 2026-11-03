import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText } from "lucide-react";
import { Icon } from "../../primitives/Icon";
import { Row } from "../../primitives/Row";
import { ModeTag } from "../identity/ModeTag";
import { SectionList } from "./SectionList";

const meta: Meta<typeof SectionList> = {
  title: "Components/Data/SectionList",
  component: SectionList,
  decorators: [
    (Story) => (
      <div className="flex w-80 flex-col rounded-xl bg-surface p-3">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SectionList>;

export const TwoSectionsOneEmpty: Story = {
  render: () => (
    <>
      <SectionList label="Guild notes" count={3}>
        <Row asChild interactive selected density="compact" mono lead={<Icon icon={FileText} />} title="playbook.md" trail={<ModeTag mode="all_write" />}>
          <button type="button" />
        </Row>
        <Row asChild interactive density="compact" mono lead={<Icon icon={FileText} />} title="sources.md" trail={<ModeTag mode="some" />}>
          <button type="button" />
        </Row>
        <Row asChild interactive muted density="compact" mono lead={<Icon icon={FileText} />} title="drafts.md" trail={<ModeTag mode="none" />}>
          <button type="button" />
        </Row>
      </SectionList>
      <SectionList label="Shared with this guild" count={0} empty="No notes are shared with this guild." />
    </>
  ),
};

export const Closed: Story = {
  render: () => (
    <SectionList label="Guild notes" count={1} defaultOpen={false}>
      <Row asChild interactive density="compact" mono lead={<Icon icon={FileText} />} title="playbook.md" trail={<ModeTag mode="read" />}>
        <button type="button" />
      </Row>
    </SectionList>
  ),
};
