import type { Run } from "../../../api/types";
import { promptSections } from "@guildsrun/ui";
import type { PromptSection, OfferedToolGroup } from "@guildsrun/ui";
/** The system message's four sections, as the run hydrated them. */
export function promptSectionsOf(content: string): Partial<Record<PromptSection, string>> {
  const sections: Partial<Record<PromptSection, string>> = {};
  for (const name of promptSections) {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content);
    if (match?.[1] !== undefined) sections[name] = match[1].trim();
  }
  return sections;
}

/** The tools the run offered the model, grouped by the connected server that serves them. */
export function offeredToolGroups(run: Run): OfferedToolGroup[] {
  const serverOf = new Map<string, string>();
  for (const server of run.config_snapshot.mcp ?? []) {
    for (const tool of server.tools) serverOf.set(tool.name, server.slug);
  }
  const groups = new Map<string, OfferedToolGroup>();
  for (const tool of run.config_snapshot.tools ?? []) {
    const name = tool.function?.name ?? tool.name;
    if (!name) continue;
    const server = serverOf.get(name) ?? "guilds.run";
    const group = groups.get(server) ?? { server, tools: [] };
    const description = tool.function?.description;
    group.tools.push(description ? { name, description } : { name });
    groups.set(server, group);
  }
  return [...groups.values()];
}
