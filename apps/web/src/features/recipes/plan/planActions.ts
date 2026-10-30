import type {
  AuthorDraft,
  BrowserSiteDraft,
  ConnectionDraft,
  ExternalDraft,
  RepositoryDraft,
  SecretDraft,
} from "./recipeDraft";
import type { PlanAgent } from "./planAgents";
import { reusesLogin } from "./planConnectors";

/**
 * One operator step apply needs: a connector login, a secret, a repository to add, a browser
 * login, or an external setup.
 */
export type PlanAction = {
  kind: "connect" | "reuse" | "secret" | "repository" | "browser" | "external";
  title: string;
  detail: string;
  path: string;
  author: AuthorDraft | null;
  required: boolean;
  server?: string;
  role?: string;
};

/** The step a connector needs: reusing the live login apply found, or connecting one. */
export function connectionAction(connection: ConnectionDraft): PlanAction {
  const reused = reusesLogin(connection);
  return {
    kind: reused ? "reuse" : "connect",
    title: reused ? `Reuse ${connection.server}` : `Connect ${connection.server}`,
    detail:
      connection.setup ||
      connection.hint ||
      `${connection.auth || "oauth"} · ${connection.recommended_scope || "guild"}`,
    path: `connections.${connection.server}.setup`,
    author: connection.author || null,
    required: !reused,
    server: connection.server ?? "",
  };
}

/** The step a secret needs: providing it, required unless apply reuses or skips it. */
export function secretAction(secret: SecretDraft): PlanAction {
  return {
    kind: "secret",
    title: `Provide ${secret.dest_name || secret.name}`,
    detail: secret.description || secret.recommended_scope || "",
    path: `secrets.${secret.name}`,
    author: null,
    required: secret.action !== "reuse" && secret.action !== "skip",
  };
}

/** The GitHub login a recipe's repositories need when no connector of the recipe provides it. */
const connectGitHub: PlanAction = {
  kind: "connect",
  title: "Connect GitHub",
  detail:
    "Install the GitHub App on the account that owns the repositories, or reuse an existing install. Pick this login's repositories on the GitHub card in Tools.",
  path: "repositories",
  author: null,
  required: false,
  server: "github",
};

/**
 * The steps a recipe's repositories need: connecting GitHub, unless one of the connectors is
 * GitHub, then adding each repository.
 */
export function repositoryActions(
  repositories: readonly RepositoryDraft[],
  connections: readonly ConnectionDraft[],
): PlanAction[] {
  const github =
    repositories.length && !connections.some((connection) => connection.server === "github")
      ? [connectGitHub]
      : [];
  return [
    ...github,
    ...repositories.map((repository): PlanAction => ({
      kind: "repository",
      title: `Add the ${repository.name ?? ""} repository`,
      detail: repository.purpose || "Add it in the guild's Settings under Repositories.",
      path: `repositories.${repository.name ?? ""}`,
      author: null,
      required: true,
    })),
  ];
}

/** The login step each browser agent needs, naming the site it logs into. */
export function browserActions(
  agents: readonly PlanAgent[],
  browserSites: readonly BrowserSiteDraft[],
): PlanAction[] {
  return agents
    .filter((agent) => agent.browser)
    .map((agent) => {
      const site = browserSites.find((item) => item.role === agent.role)?.site;
      return {
        kind: "browser",
        title: `Take control and log ${agent.name} into ${site || "the web page"}`,
        detail:
          agent.browserInstructions ||
          "No native connector. After apply, open this agent and log in from the Browser tab.",
        path: `roles.${agent.role}.browser`,
        author: agent.browserAuthor,
        required: true,
        role: agent.role,
      };
    });
}

/** The step each external setup card needs, in the recipe's order. */
export function externalActions(external: readonly ExternalDraft[]): PlanAction[] {
  return external.map((card, index) => ({
    kind: "external",
    title: card.title || card.kind || "External setup",
    detail: card.setup || "",
    path: `external[${index}]`,
    author: card.author || null,
    required: true,
  }));
}

/** An external setup card: its title (or kind) and setup text. */
export function externalCard(card: ExternalDraft): { title: string; setup: string } {
  return { title: card.title || card.kind || "", setup: card.setup || "" };
}
