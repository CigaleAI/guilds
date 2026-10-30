import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The GitHub replies this module reads. Each object keeps the fields GitHub sends beyond the ones
// named; a field read only when it has the type expected is `Shown`.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** The body of a refused call that says why. */
export const ErrorReply = Type.Object({ message: Type.String() });

/** A code exchange that gave the user's token. */
export const UserTokenReply = Type.Object({ access_token: Type.String({ minLength: 1 }) });

/** A code exchange GitHub refused, by the error it names. */
export const OAuthErrorReply = Type.Object({ error: Type.String() });

/** An installation of a GitHub App on an account; an enterprise account has no login. */
export const InstallationReply = Type.Object({
  id: Type.Integer(),
  account: Nullable(Type.Object({ login: Type.Optional(Type.String()) })),
  app_id: Nullable(Type.Union([Type.Integer(), Type.String()])),
  updated_at: Type.Optional(Type.String()),
});
export type InstallationReply = Static<typeof InstallationReply>;

/** One page of the installations a user token reaches. */
export const InstallationsPage = Type.Object({ installations: Type.Array(InstallationReply) });

/** A repository a scoped installation token lists, by its id and its current `owner/name`. */
export const TokenRepositoryReply = Type.Object({ id: Type.Integer(), full_name: Type.String() });

/** A minted installation token; its repositories are listed only when it is scoped to some. */
export const InstallationTokenReply = Type.Object({
  token: Type.String(),
  expires_at: Type.String(),
  repositories: Type.Optional(Type.Array(Type.Unknown())),
});

/** A repository as an installation's listing gives it; only its id is always read. */
export const RepositoryReply = Type.Object({
  id: Type.Integer(),
  name: Type.Optional(Type.String()),
  full_name: Type.Optional(Type.String()),
  owner: Nullable(Type.Object({ login: Type.Optional(Type.String()) })),
  private: Type.Optional(Type.Boolean()),
  default_branch: Type.Optional(Type.String()),
});

/** One page of the repositories an installation reaches. */
export const RepositoriesPage = Type.Object({ repositories: Type.Array(RepositoryReply) });

/** A new App from a manifest code: each credential is read only when it holds a value. */
export const ManifestConversionReply = Type.Object({
  id: Shown,
  slug: Shown,
  pem: Shown,
  client_id: Shown,
  client_secret: Shown,
  html_url: Shown,
});
