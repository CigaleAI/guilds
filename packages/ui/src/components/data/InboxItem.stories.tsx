import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { IdentityTone } from "../../identity";
import { Avatar } from "../identity/Avatar";
import { InboxItem } from "./InboxItem";

const meta: Meta<typeof InboxItem> = {
  title: "Components/Data/InboxItem",
  component: InboxItem,
};
export default meta;

type Story = StoryObj<typeof InboxItem>;

type Entry = {
  id: string;
  title: string;
  meta: string;
  age: string;
  unread: boolean;
  author: { name: string; tone: IdentityTone; person?: boolean };
};

const entries: Entry[] = [
  {
    id: "iss_212",
    title: "Wallet credentials missing",
    meta: "Degen-capital · issue",
    age: "6h",
    unread: true,
    author: { name: "wallet", tone: "tide" },
  },
  {
    id: "msg_881",
    title: "managooor tagged you",
    meta: "Degen-capital · mention",
    age: "7h",
    unread: true,
    author: { name: "managooor", tone: "rosewood" },
  },
  {
    id: "msg_874",
    title: "Hugo tagged you",
    meta: "Cigale-Replies-Auto · mention",
    age: "9h",
    unread: true,
    author: { name: "Hugo Laurent", tone: "dusk", person: true },
  },
  {
    id: "iss_204",
    title: "Scout lead lacks verified contract",
    meta: "Degen-capital · issue",
    age: "1d",
    unread: false,
    author: { name: "skyzo", tone: "signal" },
  },
  {
    id: "iss_031",
    title: "LinkedIn rate limit reached",
    meta: "Link-Prospection · issue",
    age: "1d",
    unread: false,
    author: { name: "linkoor", tone: "tide" },
  },
];

function InboxList() {
  const [selected, setSelected] = useState("iss_212");
  return (
    <div className="flex max-w-md flex-col gap-1 rounded-xl bg-paper p-3">
      {entries.map((entry) => (
        <InboxItem
          key={entry.id}
          avatar={
            <Avatar
              name={entry.author.name}
              tone={entry.author.tone}
              size={32}
              {...(entry.author.person ? { round: true } : {})}
            />
          }
          title={entry.title}
          meta={entry.meta}
          age={entry.age}
          unread={entry.unread}
          selected={selected === entry.id}
          onClick={() => setSelected(entry.id)}
        />
      ))}
    </div>
  );
}

export const List: Story = {
  render: () => <InboxList />,
};

export const Narrow: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-1 rounded-xl bg-paper p-3">
      <InboxItem
        avatar={<Avatar name="researchoor" tone="moss" size={32} />}
        title="Top-10 holder concentration check returned a truncated list"
        meta="Degen-capital · issue"
        age="2d"
        unread
      />
      <InboxItem
        avatar={<Avatar name="researchoor" tone="moss" size={32} />}
        title="Top-10 holder concentration check returned a truncated list"
        meta="Degen-capital · issue"
        age="2d"
        unread
        selected
      />
    </div>
  ),
};
