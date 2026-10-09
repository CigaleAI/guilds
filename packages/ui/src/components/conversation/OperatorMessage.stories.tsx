import type { Meta, StoryObj } from "@storybook/react-vite";
import { identityTones } from "../../identity";
import { Markdown } from "../content/Markdown";
import { AgentMessage } from "./AgentMessage";
import { OperatorMessage } from "./OperatorMessage";

const meta: Meta<typeof OperatorMessage> = {
  title: "Components/Conversation/OperatorMessage",
  component: OperatorMessage,
  args: {
    author: "Operator",
    seq: 30,
    layout: "chat",
    children: "If wallet only holds ETH, swap enough to reach the target buy.",
  },
  argTypes: {
    tone: { control: "select", options: [undefined, ...identityTones] },
  },
};
export default meta;

type Story = StoryObj<typeof OperatorMessage>;

export const Playground: Story = {
  render: (args) => (
    <div className="flex max-w-sm flex-col rounded-xl bg-surface p-6">
      <OperatorMessage {...args} />
    </div>
  ),
};

/** Each person's messages take their identity colour; someone without one stays plum. */
export const Colours: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <OperatorMessage author="Operator" time="09:10 AM" seq={26}>
        <Markdown density="compact" mentions={["cigale-agent"]}>
          {"No colour chosen: @cigale-agent do your thing"}
        </Markdown>
      </OperatorMessage>
      {identityTones.map((tone, index) => (
        <OperatorMessage key={tone} author={tone} tone={tone} time="09:12 AM" seq={27 + index}>
          <Markdown density="compact" mentions={["cigale-agent"]}>
            {
              "@cigale-agent skip posts under 50k views and check `x-replies` first. [Posting rules](https://example.com)"
            }
          </Markdown>
        </OperatorMessage>
      ))}
    </div>
  ),
};

export const DirectChat: Story = {
  render: () => (
    <div className="flex flex-col rounded-xl bg-paper p-6">
      <OperatorMessage
        author="You"
        tone="signal"
        person={{ name: "Emma Martin" }}
        className="text-lg"
      >
        Every 24h, do a retrospective of the day. Ask researchoor to check the status of previous
        closed and exited calls, see how your decisions held up, and fold the learnings into the
        fund thesis, your memory and the scoring system.
      </OperatorMessage>
    </div>
  ),
};

export const PeerInGroupChat: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <AgentMessage name="skyzo" tone="ochre" time="09:10 AM" seq={41}>
        Mint sniping resumes at 10:00 unless someone objects.
      </AgentMessage>
      <OperatorMessage
        author="Lucas Petit"
        tone="dusk"
        person={{ name: "Lucas Petit" }}
        time="09:12 AM"
        seq={42}
      >
        <Markdown density="compact" mentions={["skyzo"]}>
          {"@skyzo pause the mint sniping until the treasury report is back."}
        </Markdown>
      </OperatorMessage>
      <OperatorMessage author="You" tone="moss" time="09:13 AM" seq={43}>
        Agreed, hold until then.
      </OperatorMessage>
    </div>
  ),
};

export const StudioCoach: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col rounded-xl bg-surface p-5">
      <OperatorMessage layout="coach" seq={30}>
        If the manager requires a $1k buy but wallet only holds the native token on that chain (say
        ETH), it should swap the equivalent amount of ETH to reach the target buy.
      </OperatorMessage>
    </div>
  ),
};
