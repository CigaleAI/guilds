import type { AuthorDraft, ExternalDraft } from "./recipeDraft";

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

/** An external setup card: its title (or kind) and setup text. */
export function externalCard(card: ExternalDraft): { title: string; setup: string } {
  return { title: card.title || card.kind || "", setup: card.setup || "" };
}
