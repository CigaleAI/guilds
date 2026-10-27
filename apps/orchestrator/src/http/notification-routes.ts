import type { FastifyInstance } from "fastify";
import type { Notifications } from "../notifications/index.js";
import type { AppDeps } from "./deps.js";
import { currentOrg, currentUser, identityDatabase } from "./identity.js";
import { pipeSse } from "./sse.js";

/** The request's inbox in its organisation: open issues, mentions and unread group chats. */
export async function registerNotificationRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  notifications: Notifications,
): Promise<void> {
  const identityDb = identityDatabase(deps.db);

  app.get("/api/notifications", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return notifications.list(String(org.id), String(user.id));
  });

  app.post("/api/notifications/read", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return notifications.markMentionsRead(String(org.id), String(user.id));
  });

  app.get("/api/notifications/stream", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const userId = String(user.id);
    await pipeSse(
      request,
      reply,
      () => notifications.subscribe(userId, String(org.id)),
      (queue) => notifications.unsubscribe(userId, queue),
    );
  });
}
