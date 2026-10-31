import type { CatalogServer } from "../../api/types/admin";

/** A remote server added on this box, as its edit form holds it: every text field a string. */
export type RemoteServerDraft = Pick<
  CatalogServer,
  "slug" | "display_name" | "auth" | "oauth_strategy" | "description"
> & {
  url: string;
  limitations: string;
  setup_hint: string;
};
