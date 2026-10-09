import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { LabelledDivider } from "../../primitives/Divider";
import { Tag } from "../../primitives/Tag";
import { AgentMessage } from "./AgentMessage";
import { OperatorMessage } from "./OperatorMessage";
import { TypingIndicator } from "./TypingIndicator";

const meta: Meta<typeof AgentMessage> = {
  title: "Components/Conversation/AgentMessage",
  component: AgentMessage,
  args: { name: "wallet", tone: "tide", time: "06:00 AM", bubble: "paper" },
};
export default meta;

type Story = StoryObj<typeof AgentMessage>;

function Bullets({ items }: { items: Array<{ dot: string; content: ReactNode }> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5 leading-normal">
          <span className={`mt-2 size-1.5 shrink-0 rounded-full ${item.dot}`} />
          <span>{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

function Treasury() {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-sm font-medium">HOURLY TREASURY — 04:00 UTC</p>
      <Bullets
        items={[
          {
            dot: "bg-plum",
            content: (
              <>
                <b>Valuation incomplete:</b> wallet reads failed on every chain.
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

function Updated({ file }: { file: string }) {
  return (
    <>
      Updated
      <Tag tone="well" className="text-xs">
        {file}
      </Tag>
    </>
  );
}

export const Playground: Story = {
  render: (args) => (
    <div className="rounded-xl bg-surface p-6">
      <AgentMessage
        {...args}
        onInspectRun={() => {}}
        footer={<Updated file="portfolio_valuation.md" />}
      >
        <Treasury />
      </AgentMessage>
    </div>
  ),
};

export const CoachReply: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      <AgentMessage name="Studio coach" tone="signal" seq={37} hideAvatar>
        <p>
          Agreed. I created Wallet task draft{" "}
          <Tag tone="well" className="text-xs">
            std_01M3CE1FV4D03E
          </Tag>{" "}
          with that funding behaviour. The draft is ready but <b>not published</b>.
        </p>
      </AgentMessage>
    </div>
  ),
};

export const GroupChat: Story = {
  render: () => (
    <div className="flex flex-col gap-5 rounded-xl bg-paper p-6">
      <LabelledDivider label="Routine · hourly treasury · 03:00 UTC" />
      <AgentMessage
        name="managooor"
        tone="rosewood"
        time="05:00 AM"
        bubble="surface"
        onInspectRun={() => {}}
        onOpenAgent={() => {}}
      >
        <p className="text-lg leading-normal">
          Acknowledged. <b>No allocation action:</b> valuation, balances, gas and holdings remain
          unverifiable; no BUY/SELL orders created. Fund stays flat and will not size trades until
          wallet credentials recover.
        </p>
      </AgentMessage>
      <AgentMessage
        name="wallet"
        tone="tide"
        time="06:00 AM"
        bubble="surface"
        onInspectRun={() => {}}
        onOpenAgent={() => {}}
        footer={
          <>
            <Updated file="portfolio_valuation.md" />· No orders executed.
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="font-mono text-sm font-medium">HOURLY TREASURY — 04:00 UTC</p>
          <div>
            <Tag tone="plum" font="sans">
              @managooor
            </Tag>
          </div>
          <Bullets
            items={[
              {
                dot: "bg-plum",
                content: (
                  <>
                    <b>Valuation incomplete:</b> live wallet reads failed on every configured chain.
                  </>
                ),
              },
              {
                dot: "bg-dusk",
                content: (
                  <>
                    Gas reserves and material holdings: <b>not verifiable this run</b>.
                  </>
                ),
              },
            ]}
          />
        </div>
      </AgentMessage>
      <OperatorMessage
        author="You"
        tone="signal"
        person={{ name: "Emma Martin" }}
        time="06:04 AM"
        seq={31}
      >
        @wallet if you only hold ETH, swap enough to reach the target buy.
      </OperatorMessage>
      <TypingIndicator
        name="skyzo"
        tone="signal"
        caption="skyzo is scanning the trenches…"
        bubble="surface"
      />
    </div>
  ),
};
