import { operatorNotifications } from "../notifications/index.js";
import { registerAccessRoutes } from "./access-routes.js";
import { registerAdminInstanceRoutes } from "./admin-instance-routes.js";
import { registerAdminMcpRoutes } from "./admin-mcp-routes.js";
import { registerAdminRegistryRoutes } from "./admin-registry-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerArtifactAccessRoutes } from "./artifact-access-routes.js";
import { registerAttachmentRoutes } from "./attachment-routes.js";
import { registerBindingRoutes } from "./binding-routes.js";
import { registerBuilderCapabilityRoutes } from "./builder-capability-routes.js";
import { registerBuilderSessionRoutes } from "./builder-routes.js";
import { registerCodingRoutes } from "./coding-routes.js";
import { registerCollectionRoutes } from "./collection-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { registerFileRoutes } from "./file-routes.js";
import { registerGroupChatRoutes } from "./group-chat-routes.js";
import { registerGuildRoutes } from "./guild-routes.js";
import { registerInstanceRoutes } from "./instance-routes.js";
import { registerIssueRoutes } from "./issue-routes.js";
import { registerMachineRoutes } from "./machine-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerModelProviderRoutes } from "./model-provider-routes.js";
import { registerNoteRoutes } from "./note-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerOAuthRoutes } from "./oauth-routes.js";
import { registerOrgConnectorRoutes } from "./org-connector-routes.js";
import { registerOrgRoutes } from "./org-routes.js";
import { registerRecipeRoutes } from "./recipe-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import { registerScheduleRoutes } from "./schedule-routes.js";
import { registerScriptRoutes } from "./script-routes.js";
import { registerSecretRoutes } from "./secret-routes.js";
import { registerStudioRoutes } from "./studio-routes.js";
import { registerUsageRoutes } from "./usage-routes.js";
import { registerUserRoutes } from "./user-routes.js";

/** Every route of the app's domains, each from the file of its own domain. */
export async function registerDomainRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const notifications = operatorNotifications(deps.db);

  deps.generation?.groupChat.observe((guildId, event, data) =>
    notifications.observe(guildId, event, data),
  );
  await registerMeRoutes(app, deps);
  await registerCodingRoutes(app, deps);
  await registerModelProviderRoutes(app, deps);
  await registerStudioRoutes(app, deps);
  await registerFileRoutes(app, deps);
  await registerAdminMcpRoutes(app, deps);
  await registerAdminRegistryRoutes(app, deps);
  await registerAdminInstanceRoutes(app, deps);
  await registerOrgConnectorRoutes(app, deps);
  await registerMachineRoutes(app, deps);
  await registerBuilderCapabilityRoutes(app, deps);
  await registerBuilderSessionRoutes(app, deps);
  await registerRecipeRoutes(app, deps);

  app.addHook("onSend", async (request, reply, payload) => {
    deps.identity?.onSend?.(request, reply);
    return payload;
  });
  await registerUserRoutes(app, deps);
  await registerOrgRoutes(app, deps);
  await registerGuildRoutes(app, deps);
  await registerGroupChatRoutes(app, deps, notifications);
  await registerNotificationRoutes(app, deps, notifications);
  await registerScheduleRoutes(app, deps);
  await registerScriptRoutes(app, deps);
  await registerIssueRoutes(app, deps);
  await registerAgentRoutes(app, deps);
  await registerRunRoutes(app, deps);
  await registerSandboxRoutes(app, deps);
  await registerUsageRoutes(app, deps);
  await registerAccessRoutes(app, deps);
  await registerAttachmentRoutes(app, deps);
  await registerNoteRoutes(app, deps);
  await registerCollectionRoutes(app, deps);
  await registerArtifactAccessRoutes(app, deps);
  await registerSecretRoutes(app, deps);
  await registerBindingRoutes(app, deps);
  await registerConnectionRoutes(app, deps);
  await registerOAuthRoutes(app, deps);
  await registerInstanceRoutes(app, deps);
}
