import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Paths the orchestrator answers itself; the app never falls back for them. */
const SERVER_PATHS = ["/api/", "/assets/", "/avatars/", "/storybook"];

/**
 * A page of the React app: a browser navigation (it accepts HTML) to a path the server does not
 * own. Missing files, API calls and anything else stay JSON 404s.
 */
function isAppPage(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = request.url.split("?")[0] ?? "";
  if (SERVER_PATHS.some((prefix) => pathname.startsWith(prefix)) || pathname === "/health") {
    return false;
  }
  return String(request.headers.accept ?? "").includes("text/html");
}

/**
 * Serves the React app's build from `distDir` at the site root and owns the not-found handler: app
 * pages fall back to index.html so the client router can resolve them; everything else is a JSON
 * 404. Hashed assets are immutable; index.html is never cached. Without a build, every page is a
 * 404. The Storybook build at `distDir/storybook` is `/storybook`.
 */
export async function registerWebApp(app: FastifyInstance, distDir: string): Promise<void> {
  const indexFile = path.join(distDir, "index.html");
  const assetsDir = path.join(distDir, "assets");
  const storybookIndex = path.join(distDir, "storybook", "index.html");
  const built = existsSync(indexFile);
  const storybookBuilt = existsSync(storybookIndex);
  const sendHtml = (reply: FastifyReply, file: string) =>
    reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-cache, no-store, must-revalidate")
      .send(readFileSync(file));
  const sendIndex = (reply: FastifyReply) => sendHtml(reply, indexFile);
  if (built) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: "/",
      wildcard: false,
      decorateReply: false,
      index: false,
      setHeaders: (reply, filePath) => {
        reply.header(
          "Cache-Control",
          filePath.startsWith(assetsDir) ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    });
    app.get("/", async (_request, reply) => sendIndex(reply));
  }
  if (storybookBuilt) {
    const sendStorybook = (reply: FastifyReply) => sendHtml(reply, storybookIndex);
    app.get("/storybook", async (_request, reply) => sendStorybook(reply));
    app.get("/storybook/", async (_request, reply) => sendStorybook(reply));
  }
  app.setNotFoundHandler((request, reply) => {
    if (built && isAppPage(request)) return sendIndex(reply);
    return reply.code(404).send({ detail: "Not Found" });
  });
}
