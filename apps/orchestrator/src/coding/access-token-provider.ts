import { decryptPayload } from "../credentials/crypto.js";
import { secretValue } from "../credentials/validate.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getSecret } from "../db/secrets.js";
import { RepositoryAccessError } from "../github/tokens.js";
import type { GitProvider, TokenEntry } from "./git.js";
import type { CodingRepository } from "./repositories.js";

/** A character git's credential protocol reads as the end of a value. */
const LINE_END = /[\r\n\0]/;

/** The db/ functions an access token is read through, on `db`. */
function accessTokenProviderDatabase(db: Queryable) {
  return { getSecret: bindQuery(db, getSecret) };
}

export type AccessTokenProviderDb = ReturnType<typeof accessTokenProviderDatabase>;

/** Where git asks for a repository's credential: its URL's host, with a port other than 443, and its path. */
export function credentialTarget(url: string): Pick<TokenEntry, "host" | "path"> {
  const parsed = new URL(url);
  return { host: parsed.host.toLowerCase(), path: parsed.pathname.replace(/^\/+/, "") };
}

/**
 * A stored access token as a git provider, for a repository on any HTTPS host: its token is the
 * value of the secret the repository names, read when the run starts, and sent with the
 * repository's username. It never expires, so it is never refreshed.
 */
export class AccessTokenProvider implements GitProvider {
  constructor(private db: AccessTokenProviderDb) {}

  /** Each repository's entry, answered only for its own URL's host and path. */
  async mint(repositories: CodingRepository[]): Promise<Map<string, TokenEntry>> {
    const entries = new Map<string, TokenEntry>();
    for (const row of repositories) {
      if (row.secret_id === null || row.username === null) {
        throw new RepositoryAccessError(`${row.name} has no access token`);
      }
      entries.set(row.name, {
        token: await this.secretToken(row.name, row.secret_id),
        expires_at: null,
        ...credentialTarget(row.url),
        username: row.username,
        provider: "access_token",
      });
    }
    return entries;
  }

  /** The value of the secret that holds a repository's token; a secret that is gone, cannot be read, or spans lines is refused. */
  private async secretToken(repository: string, secretId: string): Promise<string> {
    const secret = await this.db.getSecret(secretId);
    if (secret === null) {
      throw new RepositoryAccessError(`${repository}: the secret that holds its access token is gone`);
    }
    let token: string;
    try {
      token = secretValue(decryptPayload(secret.ciphertext, secret.nonce));
    } catch {
      throw new RepositoryAccessError(`${repository}: the secret ${secret.name} that holds its access token cannot be read`);
    }
    if (LINE_END.test(token)) {
      throw new RepositoryAccessError(
        `${repository}: the secret ${secret.name} holds a line break, which git cannot send as a token`,
      );
    }
    return token;
  }
}

/** A stored access token as the git provider of a run's repositories, read on `db`. */
export function accessTokenProvider(db: Queryable): AccessTokenProvider {
  return new AccessTokenProvider(accessTokenProviderDatabase(db));
}
