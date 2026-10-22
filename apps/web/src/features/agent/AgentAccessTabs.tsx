import { useParams } from "@tanstack/react-router";
import { useAgent } from "../../api/queries";
import { AccessSecrets } from "../access/AccessSecrets";
import { AccessTools } from "../access/AccessTools";
import { ReachList } from "../access/ReachList";
import { capabilityOn } from "./settings/configForm";

/** The agent's Tools tab: integrations and native tools, over what its guild gives it. */
export function AgentToolsTab() {
  const { agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  return (
    <AccessTools
      owner={{ scope: "agent", id: agentId }}
      panes={["connections", "builtin"]}
      capabilities={{
        browser: capabilityOn(agent.data?.config, "browser"),
        coding: capabilityOn(agent.data?.config, "coding"),
      }}
    />
  );
}

/** The agent's State sub-tab: the notes and tables it reaches. */
export function AgentReachTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  return <ReachList subject={{ type: "agent", id: agentId }} guildId={guildId} />;
}

/** The agent's Secrets tab. */
export function AgentSecretsTab() {
  const { agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  return <AccessSecrets owner={{ scope: "agent", id: agentId }} />;
}
