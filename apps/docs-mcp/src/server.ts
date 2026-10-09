import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, type DocsMcpConfig } from "./config.js";
import { entityGraph, searchDocs, searchLabels, type SearchMode } from "./lightrag.js";

const SEARCH_DESCRIPTION =
  "Returns matching architecture-doc segments (filename + excerpt). Default naive is vector retrieval, not a generated answer. " +
  "Use for questions about topology, auth, hosted phases, sandboxes, tools, and locked decisions. " +
  "Not for source code; grep the repo for that. Pass mode mix only when you need the entity graph.";

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(config: DocsMcpConfig = loadConfig()): McpServer {
  const server = new McpServer({ name: "guilds-docs", version: "0.1.0" });

  server.tool(
    "docs_search",
    SEARCH_DESCRIPTION,
    {
      query: z
        .string()
        .trim()
        .min(3)
        .describe("Natural-language question or identifier, e.g. AUTH_MODE or sandbox idle stop"),
      mode: z
        .enum(["naive", "mix", "hybrid", "local", "global"])
        .optional()
        .describe("naive = matching segments only (default). mix = graph + vector. local/global/hybrid use the entity graph."),
      top_k: z.number().int().min(1).max(80).optional().describe("Entity/relation hit cap. Default 40."),
      chunk_top_k: z.number().int().min(1).max(30).optional().describe("Chunk hit cap. Default 12."),
    },
    async ({ query, mode, top_k, chunk_top_k }) => {
      try {
        const text = await searchDocs(config, {
          query,
          mode: (mode ?? "naive") as SearchMode,
          topK: top_k ?? 40,
          chunkTopK: chunk_top_k ?? 12,
        });
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "docs_entity",
    "Return the knowledge-graph neighborhood of one architecture entity (AUTH_MODE, organisation, sandbox_hosts, …).",
    {
      label: z.string().trim().min(1).describe("Entity name as it appears in the graph"),
      max_depth: z.number().int().min(1).max(4).optional().describe("Hop count. Default 2."),
      max_nodes: z.number().int().min(5).max(80).optional().describe("Node cap. Default 40."),
    },
    async ({ label, max_depth, max_nodes }) => {
      try {
        const text = await entityGraph(config, label, max_depth ?? 2, max_nodes ?? 40);
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "docs_labels",
    "Fuzzy-find entity names in the architecture knowledge graph before calling docs_entity.",
    {
      query: z.string().trim().min(1).describe("Substring or name to match, e.g. sandbox or AUTH"),
      limit: z.number().int().min(1).max(40).optional().describe("Max labels. Default 20."),
    },
    async ({ query, limit }) => {
      try {
        const text = await searchLabels(config, query, limit ?? 20);
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
