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

/** How a recipe's repository is added after apply: by its URL, with the credential it is cloned with. */
const ADD_REPOSITORY =
  "Add it in the guild's Settings under Repositories, with its HTTPS URL and a credential: a GitHub login, an access token, or none for a public repository.";

/** The step each repository of a recipe needs: adding it with its URL and a credential. */
export function repositoryActions(repositories: readonly RepositoryDraft[]): PlanAction[] {
  return repositories.map((repository): PlanAction => ({
    kind: "repository",
    title: `Add the ${repository.name ?? ""} repository`,
    detail: [repository.purpose, ADD_REPOSITORY].filter(Boolean).join(" "),
    path: `repositories.${repository.name ?? ""}`,
    author: null,
    required: true,
  }));
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
export type ExternalCard = { title: string; setup: string };

/** The card an external setup step shows. */
export function externalCard(card: ExternalDraft): ExternalCard {
  return { title: card.title || card.kind || "", setup: card.setup || "" };
}
