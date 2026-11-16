import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tempDir } from "./env.js";

/** One request the server answered: the username it carried, or null without credentials, and its status. */
export type GitServerRequest = { username: string | null; status: number; path: string };

/**
 * A private git host over HTTPS on 127.0.0.1: `git http-backend` behind basic auth that takes one
 * username and token, with a self-signed certificate in `caFile` for git to trust. It refuses a
 * request without them, as a private repository on GitLab, Bitbucket, Gitea or Azure DevOps does.
 */
export class GitServer {
  readonly root = tempDir("git-server-");
  readonly caFile: string;
  readonly requests: GitServerRequest[] = [];
  private server: Server;

  constructor(
    private username: string,
    private token: string,
  ) {
    const certificate = tempDir("git-server-tls-");
    const key = path.join(certificate, "key.pem");
    this.caFile = path.join(certificate, "cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", this.caFile, "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    this.server = createServer({ key: readFileSync(key), cert: readFileSync(this.caFile) }, (request, response) => {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const given = this.credentials(request.headers.authorization);
      if (given?.username !== this.username || given.token !== this.token) {
        this.requests.push({ username: given?.username ?? null, status: 401, path: url.pathname });
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
        return;
      }
      this.requests.push({ username: given.username, status: 200, path: url.pathname });
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          ...(request.headers["content-length"] ? { CONTENT_LENGTH: request.headers["content-length"] } : {}),
          ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
          ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
          REMOTE_USER: given.username,
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      request.pipe(backend.stdin);
      let head = Buffer.alloc(0);
      let answered = false;
      backend.stdout.on("data", (chunk: Buffer) => {
        if (answered) {
          response.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          return;
        }
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") {
            status = Number.parseInt(value, 10);
          } else {
            headers[name] = value;
          }
        }
        response.writeHead(status, headers);
        response.write(head.subarray(end + 4));
        answered = true;
      });
      backend.stdout.on("end", () => response.end());
    });
  }

  /** The username and token a basic `Authorization` header carries, or null without one. */
  private credentials(header: string | undefined): { username: string; token: string } | null {
    if (!header?.startsWith("Basic ")) {
      return null;
    }
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return { username: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
  }

  /** Starts listening on a free port of 127.0.0.1 and returns the server's base URL. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** A bare repository at `repository` (`owner/name.git`) whose `main` holds one commit of a README. */
  createRepository(repository: string): string {
    const bare = path.join(this.root, repository);
    mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", bare]);
    const seed = tempDir("git-server-seed-");
    const identity = ["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid"];
    execFileSync("git", ["init", "--quiet", "--initial-branch", "main", seed]);
    writeFileSync(path.join(seed, "README.md"), "# app\n");
    execFileSync("git", ["-C", seed, "add", "README.md"]);
    execFileSync("git", ["-C", seed, ...identity, "commit", "--quiet", "-m", "Start"]);
    execFileSync("git", ["-C", seed, "push", "--quiet", bare, "main"]);
    return bare;
  }

  /** The branches of the bare repository at `bare`, by name. */
  branches(bare: string): string[] {
    return execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
