import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { IssueCard, type IssueStatus } from "./IssueCard";

const meta: Meta<typeof IssueCard> = {
  title: "Components/Data/IssueCard",
  component: IssueCard,
  decorators: [
    (Story) => (
      <div className="flex max-w-2xl flex-col gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof IssueCard>;

function Detail({ children }: { children: string }) {
  return <p>{children}</p>;
}

function Toggle() {
  const [status, setStatus] = useState<IssueStatus>("open");
  return (
    <IssueCard
      summary="Wallet credentials missing"
      kind="api"
      severity="high"
      status={status}
      agent={{ name: "wallet", tone: "tide" }}
      age="6h"
      toolName="fetch_balances"
      {...(status === "resolved" ? { resolvedBy: "Emma Martin" } : {})}
      detail={
        <Detail>
          Live wallet reads failed on every configured chain because WALLET_KEY isn't set. managooor won't size trades
          until valuation recovers.
        </Detail>
      }
      onInvestigate={() => {}}
      onStatusChange={setStatus}
      onOpenRun={() => {}}
    />
  );
}

export const Open: Story = {
  render: () => <Toggle />,
};

export const Severities: Story = {
  render: () => (
    <>
      <IssueCard
        summary="Top-10 holder concentration check returned a truncated list"
        kind="truncated"
        severity="low"
        status="open"
        agent={{ name: "researchoor", tone: "moss" }}
        age="2d"
        toolName="alchemy_holders"
        onInvestigate={() => {}}
        onStatusChange={() => {}}
        onOpenRun={() => {}}
      />
      <IssueCard
        summary="Scout lead lacks a verified contract"
        kind="tool_failure"
        severity="medium"
        status="open"
        agent={{ name: "skyzo", tone: "signal" }}
        age="1d"
        toolName="solscan_token"
        detail={<Detail>yap.fun contract not found on Solscan; the lead stays unverified.</Detail>}
        onInvestigate={() => {}}
        onStatusChange={() => {}}
        onOpenRun={() => {}}
      />
      <IssueCard
        summary="CoinGecko API key missing"
        kind="api"
        severity="high"
        status="open"
        agent={{ name: "wallet", tone: "tide" }}
        age="6h"
        onInvestigate={() => {}}
        onStatusChange={() => {}}
      />
    </>
  ),
};

export const InInbox: Story = {
  render: () => (
    <IssueCard
      summary="Session expired"
      kind="other"
      severity="medium"
      status="open"
      agent={{ name: "skyzo", tone: "signal" }}
      guildName="X-Replies"
      age="2d"
      detail={<Detail>The X session cookie was rejected; replies are queued until the session is renewed.</Detail>}
      onInvestigate={() => {}}
      onStatusChange={() => {}}
      onOpenRun={() => {}}
    />
  ),
};

export const Resolved: Story = {
  render: () => (
    <IssueCard
      summary="Watch pass produced no output 12 times"
      kind="other"
      severity="low"
      status="resolved"
      agent={{ name: "researchoor", tone: "moss" }}
      age="3d"
      resolvedBy="Emma Martin"
      detail={<Detail>Routine ran, nothing to report. The routine's instruction now asks for a one-line summary.</Detail>}
      onStatusChange={() => {}}
      onOpenRun={() => {}}
    />
  ),
};

export const Pending: Story = {
  render: () => (
    <IssueCard
      summary="Order sizing blocked by missing valuation"
      kind="tool_failure"
      severity="high"
      status="open"
      agent={{ name: "managooor", tone: "rosewood" }}
      age="4h"
      toolName="record_search"
      pending
      onInvestigate={() => {}}
      onStatusChange={() => {}}
      onOpenRun={() => {}}
    />
  ),
};
