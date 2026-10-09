import type { Meta, StoryObj } from "@storybook/react-vite";
import { Divider } from "../../primitives/Divider";
import { Skeleton, SkeletonGroup, SkeletonRows } from "./Skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Components/Feedback/Skeleton",
  component: Skeleton,
};
export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Shapes: Story = {
  render: () => (
    <div className="flex max-w-md items-center gap-4 rounded-xl bg-surface p-6">
      <Skeleton shape="tile" />
      <Skeleton shape="circle" className="size-9" />
      <Skeleton shape="pill" className="w-18" />
      <Skeleton className="w-24" />
      <Skeleton shape="block" className="h-16 flex-1" />
    </div>
  ),
};

export const ItemAndTable: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-surface p-5">
      <SkeletonGroup delay={0} label="Loading records">
        <div className="flex gap-3">
          <Skeleton shape="tile" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="w-3/10" />
            <Skeleton className="w-9/10" />
            <Skeleton className="w-7/10" />
          </div>
        </div>
        <Divider />
        <SkeletonRows delay={0} rows={3} />
      </SkeletonGroup>
    </div>
  ),
};

export const ListRows: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-paper p-5">
      <SkeletonRows layout="list" rows={3} delay={0} label="Loading agents" />
    </div>
  ),
};

export const TableColumns: Story = {
  render: () => (
    <div className="max-w-2xl rounded-xl bg-paper p-5">
      <SkeletonRows rows={5} columns={["id", "text", "text", "pill", "meta"]} label="Loading degen-orders" />
    </div>
  ),
};
