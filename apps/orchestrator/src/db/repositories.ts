import type pg from "pg";
import type { ArtifactActor } from "../artifacts/types.js";
import type { AgentNeeds, MachineInput } from "../machines/index.js";
import type { HeldCap } from "../policy/index.js";
import type { PlannedWake } from "../schedules/window.js";
import type { Queryable } from "./pg.js";
import * as activityDb from "./activity.js";
import * as agentsDb from "./agents.js";
import * as attachmentsDb from "./attachments.js";
import * as bindingsDb from "./bindings.js";
import type { ChangeActor } from "./config-changes.js";
import * as connectorsDb from "./connectors.js";
import * as groupChatDb from "./group-chat.js";
import * as guildsDb from "./guilds.js";
import * as issuesDb from "./issues.js";
import * as machinesDb from "./machines.js";
import * as mcpDb from "./mcp.js";
import * as orgsDb from "./orgs.js";
import * as runsDb from "./runs.js";
import * as schedulesDb from "./schedules.js";
import * as secretsDb from "./secrets.js";
import * as usageDb from "./usage.js";
import * as usersDb from "./users.js";

export class Repositories {
  private orgCreated: orgsDb.OrgCreatedHook | undefined;

  constructor(
    public pool: pg.Pool,
    options: { orgCreated?: orgsDb.OrgCreatedHook | undefined } = {},
  ) {
    this.orgCreated = options.orgCreated;
  }
  listUsers() {
    return usersDb.listUsers(this.pool);
  }
  getUser(userId: string) {
    return usersDb.getUser(this.pool, userId);
  }
  getUserByName(name: string) {
    return usersDb.getUserByName(this.pool, name);
  }
  getUserByEmail(email: string) {
    return usersDb.getUserByEmail(this.pool, email);
  }
  updateUserProfile(userId: string, profile: usersDb.UserProfilePatch, now: Date) {
    return usersDb.updateUserProfile(this.pool, userId, profile, now);
  }
  setUserEmail(userId: string, email: string | null, now: Date) {
    return usersDb.setUserEmail(this.pool, userId, email, now);
  }
  insertUser(user: usersDb.NewUser, now: Date, orgCreated?: orgsDb.OrgCreatedHook) {
    return usersDb.insertUser(this.pool, user, now, orgCreated ?? this.orgCreated);
  }
  deleteUser(userId: string) {
    return usersDb.deleteUser(this.pool, userId);
  }
  listOrgsForUser(userId: string) {
    return orgsDb.listOrgsForUser(this.pool, userId);
  }
  listOrgs() {
    return orgsDb.listOrgs(this.pool);
  }
  getMembership(orgId: string, userId: string) {
    return orgsDb.getMembership(this.pool, orgId, userId);
  }
  insertOrg(org: orgsDb.NewOrg, now: Date) {
    return orgsDb.insertOrg(this.pool, org, now, this.orgCreated);
  }
  updateOrg(orgId: string, now: Date, options: { name?: string | null; slug?: string | null }) {
    return orgsDb.updateOrg(this.pool, orgId, now, options);
  }
  listMembers(orgId: string) {
    return orgsDb.listMembers(this.pool, orgId);
  }
  insertMember(orgId: string, userId: string, role: string, now: Date) {
    return orgsDb.insertMember(this.pool, orgId, userId, role, now);
  }
  updateMemberRole(orgId: string, userId: string, role: string) {
    return orgsDb.updateMemberRole(this.pool, orgId, userId, role);
  }
  deleteMember(orgId: string, userId: string) {
    return orgsDb.deleteMember(this.pool, orgId, userId);
  }
  listGuilds(orgId: string | null = null) {
    return guildsDb.listGuilds(this.pool, orgId);
  }
  listGuildsForUser(orgId: string, userId: string) {
    return guildsDb.listGuildsForUser(this.pool, orgId, userId);
  }
  hiddenGuildsFor(orgId: string, userId: string) {
    return guildsDb.hiddenGuildsFor(this.pool, orgId, userId);
  }
  listGuildViewerIds(guildId: string) {
    return guildsDb.listGuildViewerIds(this.pool, guildId);
  }
  insertGuild(guild: guildsDb.NewGuild, now: Date) {
    return guildsDb.insertGuild(this.pool, guild, now);
  }
  deleteGuild(guildId: string) {
    return guildsDb.deleteGuild(this.pool, guildId);
  }
  getGuild(guildId: string) {
    return guildsDb.getGuild(this.pool, guildId);
  }
  updateGuild(guildId: string, now: Date, options: guildsDb.GuildPatch, actor: ChangeActor) {
    return guildsDb.updateGuild(this.pool, guildId, now, options, actor);
  }
  setGuildOperator(
    guildId: string,
    userId: string,
    role: "admin" | "operator" | null,
    now: Date,
  ) {
    return guildsDb.setGuildOperator(this.pool, guildId, userId, role, now);
  }
  soleAdminGuilds(userId: string, orgId: string | null = null) {
    return guildsDb.soleAdminGuilds(this.pool, userId, orgId);
  }
  listAgents(guildId: string) {
    return agentsDb.listAgents(this.pool, guildId);
  }
  insertAgent(
    agent: agentsDb.NewAgent,
    now: Date,
    actor?: ArtifactActor,
    placement?: agentsDb.AgentPlacement,
  ) {
    return agentsDb.insertAgent(this.pool, agent, now, actor, placement);
  }
  deleteAgent(agentId: string) {
    return agentsDb.deleteAgent(this.pool, agentId);
  }
  getAgent(agentId: string) {
    return agentsDb.getAgent(this.pool, agentId);
  }
  listGuildRepositories(guildId: string) {
    return guildsDb.listGuildRepositories(this.pool, guildId);
  }
  insertGuildRepository(repository: guildsDb.NewGuildRepository, now: Date) {
    return guildsDb.insertGuildRepository(this.pool, repository, now);
  }
  deleteGuildRepository(guildId: string, repositoryId: string) {
    return guildsDb.deleteGuildRepository(this.pool, guildId, repositoryId);
  }
  listMachines(orgId: string) {
    return machinesDb.listMachines(this.pool, orgId);
  }
  getMachineWithAgents(orgId: string, machineId: string) {
    return machinesDb.getMachineWithAgents(this.pool, orgId, machineId);
  }
  placementMachine(orgId: string, machineId: string | null | undefined, needs: AgentNeeds) {
    return machinesDb.placementMachine(this.pool, orgId, machineId, needs);
  }
  getMachine(orgId: string, machineId: string) {
    return machinesDb.getMachine(this.pool, orgId, machineId);
  }
  countMachineAgents(machineId: string) {
    return machinesDb.countMachineAgents(this.pool, machineId);
  }
  insertMachine(orgId: string, machine: MachineInput, now: Date, cap: HeldCap | null = null) {
    return machinesDb.insertMachine(this.pool, orgId, machine, now, cap);
  }
  updateMachine(orgId: string, machineId: string, machine: MachineInput, now: Date) {
    return machinesDb.updateMachine(this.pool, orgId, machineId, machine, now);
  }
  deleteMachine(orgId: string, machineId: string) {
    return machinesDb.deleteMachine(this.pool, orgId, machineId);
  }
  moveAgent(
    agentId: string,
    machineId: string,
    options: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds } = {},
  ) {
    return machinesDb.moveAgent(this.pool, agentId, machineId, options);
  }
  setMachineHarnesses(machineId: string, harnesses: string[]) {
    return machinesDb.setMachineHarnesses(this.pool, machineId, harnesses);
  }
  setMachineWorkspaceMib(machineId: string, mib: number) {
    return machinesDb.setMachineWorkspaceMib(this.pool, machineId, mib);
  }
  listMachineIds() {
    return machinesDb.listMachineIds(this.pool);
  }
  listMachinePlacements() {
    return machinesDb.listMachinePlacements(this.pool);
  }
  markHarnessLogin(agentId: string, harness: string, now: Date, account: string | null) {
    return agentsDb.markHarnessLogin(this.pool, agentId, harness, now, account);
  }
  clearHarnessLogin(agentId: string, harness: string) {
    return agentsDb.clearHarnessLogin(this.pool, agentId, harness);
  }
  setAgentWorkspaceMib(agentId: string, mib: number) {
    return agentsDb.setAgentWorkspaceMib(this.pool, agentId, mib);
  }
  getAgentTask(orgId: string, agentId: string, client?: Queryable) {
    return agentsDb.getAgentTask(client ?? this.pool, orgId, agentId);
  }
  writeAgentTask(actor: ArtifactActor, agentId: string, content: string, expectedVersion?: number) {
    return agentsDb.writeAgentTask(this.pool, actor, agentId, content, expectedVersion);
  }
  writeAgentTaskInTransaction(
    client: pg.PoolClient,
    actor: ArtifactActor,
    agentId: string,
    content: string,
    expectedVersion?: number,
  ) {
    return agentsDb.writeAgentTaskInTransaction(client, actor, agentId, content, expectedVersion);
  }
  listAgentTaskRevisions(orgId: string, agentId: string) {
    return agentsDb.listAgentTaskRevisions(this.pool, orgId, agentId);
  }
  updateAgentConfig(
    agentId: string,
    config: Record<string, unknown>,
    now: Date,
    options: agentsDb.AgentConfigPatch = {},
  ) {
    return agentsDb.updateAgentConfig(this.pool, agentId, config, now, options);
  }
  upsertAgentScript(script: agentsDb.NewAgentScript, actor: ArtifactActor, now: Date) {
    return agentsDb.upsertAgentScript(this.pool, script, actor, now);
  }
  listAgentScripts(agentId: string) {
    return agentsDb.listAgentScripts(this.pool, agentId);
  }
  getAgentScript(agentId: string, name: string) {
    return agentsDb.getAgentScript(this.pool, agentId, name);
  }
  deleteAgentScript(actor: ArtifactActor, agentId: string, name: string) {
    return agentsDb.deleteAgentScript(this.pool, actor, agentId, name);
  }
  insertSchedule(schedule: schedulesDb.NewSchedule, now: Date, actor: ChangeActor) {
    return schedulesDb.insertSchedule(this.pool, schedule, now, actor);
  }
  listSchedules(agentId: string) {
    return schedulesDb.listSchedules(this.pool, agentId);
  }
  listSchedulesForGuild(guildId: string) {
    return schedulesDb.listSchedulesForGuild(this.pool, guildId);
  }
  insertIssue(issue: issuesDb.NewIssue, now: Date) {
    return issuesDb.insertIssue(this.pool, issue, now);
  }
  listIssuesForGuild(guildId: string, status: string | null) {
    return issuesDb.listIssuesForGuild(this.pool, guildId, status);
  }
  getIssue(guildId: string, issueId: string) {
    return issuesDb.getIssue(this.pool, guildId, issueId);
  }
  setIssueStatus(
    guildId: string,
    issueId: string,
    change: issuesDb.IssueStatusChange,
    now: Date,
  ) {
    return issuesDb.setIssueStatus(this.pool, guildId, issueId, change, now);
  }
  resolveOpenIssues(guildId: string, resolvedAt: Date, resolvedBy: string, now: Date) {
    return issuesDb.resolveOpenIssues(this.pool, guildId, resolvedAt, resolvedBy, now);
  }
  listInboxIssues(orgId: string, userId: string, limit: number) {
    return issuesDb.listInboxIssues(this.pool, orgId, userId, limit);
  }
  listInboxMentions(orgId: string, userId: string, limit: number) {
    return issuesDb.listInboxMentions(this.pool, orgId, userId, limit);
  }
  markInboxMentionsRead(orgId: string, userId: string, now: Date) {
    return issuesDb.markInboxMentionsRead(this.pool, orgId, userId, now);
  }
  countOpenIssues(guildId: string) {
    return issuesDb.countOpenIssues(this.pool, guildId);
  }
  deleteSchedule(agentId: string, scheduleId: string, actor: ChangeActor) {
    return schedulesDb.deleteSchedule(this.pool, agentId, scheduleId, actor);
  }
  getSchedule(agentId: string, scheduleId: string) {
    return schedulesDb.getSchedule(this.pool, agentId, scheduleId);
  }
  pauseSchedule(key: schedulesDb.ScheduleKey, now: Date, actor: ChangeActor) {
    return schedulesDb.pauseSchedule(this.pool, key, now, actor);
  }
  resumeSchedule(key: schedulesDb.ScheduleKey, wake: PlannedWake, now: Date, actor: ChangeActor) {
    return schedulesDb.resumeSchedule(this.pool, key, wake, now, actor);
  }
  updateSchedule(
    key: schedulesDb.ScheduleKey,
    update: schedulesDb.ScheduleUpdate,
    now: Date,
    actor: ChangeActor,
  ) {
    return schedulesDb.updateSchedule(this.pool, key, update, now, actor);
  }
  setScheduleNextRun(scheduleId: string, wake: PlannedWake, now: Date) {
    return schedulesDb.setScheduleNextRun(this.pool, scheduleId, wake, now);
  }
  listBindingsCovering(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }) {
    return bindingsDb.listBindingsCovering(this.pool, options);
  }
  listMcpServers(orgId: string | null = null) {
    return connectorsDb.listMcpServers(this.pool, orgId);
  }
  listMcpConnections(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }) {
    return mcpDb.listMcpConnections(this.pool, options);
  }
  listSecrets(orgId: string, options: { guildId?: string | null; agentId?: string | null } = {}) {
    return secretsDb.listSecrets(this.pool, orgId, options);
  }
  listAgentSecrets(options: { orgId: string; guildId: string; agentId: string }) {
    return secretsDb.listAgentSecrets(this.pool, options);
  }
  getSecret(secretId: string) {
    return secretsDb.getSecret(this.pool, secretId);
  }
  getSecretByName(orgId: string, name: string) {
    return secretsDb.getSecretByName(this.pool, orgId, name);
  }
  insertSecret(secret: secretsDb.NewSecret, now: Date) {
    return secretsDb.insertSecret(this.pool, secret, now);
  }
  updateSecret(
    secretId: string,
    changes: {
      name?: string | null;
      description?: string | null;
      ciphertext?: Buffer | null;
      nonce?: Buffer | null;
    },
    now: Date,
  ) {
    return secretsDb.updateSecret(this.pool, secretId, changes, now);
  }
  setSecretAccess(secretId: string, access: secretsDb.SecretAccessGrant, now: Date) {
    return secretsDb.setSecretAccess(this.pool, secretId, access, now);
  }
  deleteSecret(secretId: string) {
    return secretsDb.deleteSecret(this.pool, secretId);
  }
  countSecretsCreatedByAgent(agentId: string) {
    return secretsDb.countSecretsCreatedByAgent(this.pool, agentId);
  }
  secretGrantTargets(orgId: string, guildIds: string[], agentIds: string[]) {
    return secretsDb.secretGrantTargets(this.pool, orgId, guildIds, agentIds);
  }
  listAgentIdsReached(orgId: string, access: secretsDb.SecretAccessGrant) {
    return secretsDb.listAgentIdsReached(this.pool, orgId, access);
  }
  insertBindingIfAbsent(binding: bindingsDb.NewBinding, now: Date) {
    return bindingsDb.insertBindingIfAbsent(this.pool, binding, now);
  }
  getBinding(key: bindingsDb.BindingKey) {
    return bindingsDb.getBinding(this.pool, key);
  }
  upsertBinding(binding: bindingsDb.Binding, now: Date, actor: ChangeActor) {
    return bindingsDb.upsertBinding(this.pool, binding, now, actor);
  }
  upsertPlatformBinding(binding: bindingsDb.PlatformBinding, now: Date) {
    return bindingsDb.upsertPlatformBinding(this.pool, binding, now);
  }
  deleteBinding(key: bindingsDb.BindingKey, actor: ChangeActor) {
    return bindingsDb.deleteBinding(this.pool, key, actor);
  }
  getMcpServer(serverId: string) {
    return connectorsDb.getMcpServer(this.pool, serverId);
  }
  getMcpConnection(connectionId: string) {
    return mcpDb.getMcpConnection(this.pool, connectionId);
  }
  listVisibleGithubConnections(serverId: string, orgId: string, guildIds: string[]) {
    return mcpDb.listVisibleGithubConnections(this.pool, serverId, orgId, guildIds);
  }
  getMcpConnectionForOwner(serverId: string, ownerScope: string, ownerId: string | null) {
    return mcpDb.getMcpConnectionForOwner(this.pool, serverId, ownerScope, ownerId);
  }
  listBindingsForConnection(connectionId: string) {
    return bindingsDb.listBindingsForConnection(this.pool, connectionId);
  }
  connectMcp(connection: mcpDb.NewMcpConnection, now: Date) {
    return mcpDb.connectMcp(this.pool, connection, now);
  }
  bindMcpConnection(binding: bindingsDb.McpConnectionBinding, now: Date) {
    return mcpDb.bindMcpConnection(this.pool, binding, now);
  }
  getMcpConnectionByOauthState(oauthState: string) {
    return mcpDb.getMcpConnectionByOauthState(this.pool, oauthState);
  }
  getPendingGithubConnectionForUser(userId: string, serverId: string) {
    return mcpDb.getPendingGithubConnectionForUser(this.pool, userId, serverId);
  }
  saveMcpConnection(connectionId: string, login: mcpDb.McpConnectionLogin, now: Date) {
    return mcpDb.saveMcpConnection(this.pool, connectionId, login, now);
  }
  updateMcpConnectionSettings(
    connectionId: string,
    settings: Record<string, unknown>,
    now: Date,
    options: { connect?: boolean; accountHint?: string } = {},
  ) {
    return mcpDb.updateMcpConnectionSettings(this.pool, connectionId, settings, now, options);
  }
  updateMcpConnectionGithubRepositories(connectionId: string, repositories: unknown, now: Date) {
    return mcpDb.updateMcpConnectionGithubRepositories(
      this.pool,
      connectionId,
      repositories,
      now,
    );
  }
  replaceConnectionGuildRepositories(
    connectionId: string,
    guildId: string,
    repositories: mcpDb.ConnectionGuildRepository[],
    now: Date,
  ) {
    return mcpDb.replaceConnectionGuildRepositories(
      this.pool,
      connectionId,
      guildId,
      repositories,
      now,
    );
  }
  recordGithubRepository(
    connectionId: string,
    name: string,
    repository: { githubId: number; url: string },
    now: Date,
  ) {
    return mcpDb.recordGithubRepository(this.pool, connectionId, name, repository, now);
  }
  updateMcpServerConfig(serverId: string, config: unknown, now: Date) {
    return connectorsDb.updateMcpServerConfig(this.pool, serverId, config, now);
  }
  deleteMcpConnection(connectionId: string) {
    return mcpDb.deleteMcpConnection(this.pool, connectionId);
  }
  isListedMcpTool(namespacedName: string, orgId: string | null) {
    return mcpDb.isListedMcpTool(this.pool, namespacedName, orgId);
  }
  listMcpTools(connectionId: string) {
    return mcpDb.listMcpTools(this.pool, connectionId);
  }
  replaceMcpTools(connectionId: string, tools: mcpDb.NewMcpTool[], now: Date) {
    return mcpDb.replaceMcpTools(this.pool, connectionId, tools, now);
  }
  listAllAgents() {
    return agentsDb.listAllAgents(this.pool);
  }
  listUsageCounters() {
    return usageDb.listUsageCounters(this.pool);
  }
  getUsage(scope: string, scopeId: string) {
    return usageDb.getUsage(this.pool, scope, scopeId);
  }
  purgeAgent(agentId: string) {
    return agentsDb.deleteAgent(this.pool, agentId);
  }
  purgeGuild(guildId: string) {
    return guildsDb.deleteGuild(this.pool, guildId);
  }
  listActiveRuns() {
    return runsDb.listActiveRuns(this.pool);
  }
  listRuns(agentId: string) {
    return runsDb.listRuns(this.pool, agentId);
  }
  listRunHeaders(agentId: string, filter: runsDb.RunHeaderFilter) {
    return runsDb.listRunHeaders(this.pool, agentId, filter);
  }
  routineRunStats(scheduleIds: string[]) {
    return runsDb.routineRunStats(this.pool, scheduleIds);
  }
  getRun(runId: string) {
    return runsDb.getRun(this.pool, runId);
  }
  createRun(run: runsDb.NewDirectRun, now: Date) {
    return runsDb.createRun(this.pool, run, now);
  }
  createGroupRun(run: runsDb.NewGroupRun, now: Date) {
    return runsDb.createGroupRun(this.pool, run, now);
  }
  createScheduleRun(run: runsDb.NewScheduleRun, now: Date) {
    return runsDb.createScheduleRun(this.pool, run, now);
  }
  insertRun(run: runsDb.NewRun, now: Date) {
    return runsDb.insertRun(this.pool, run, now);
  }
  insertMessage(message: runsDb.NewMessage, now: Date) {
    return runsDb.insertMessage(this.pool, message, now);
  }
  nextSeq(runId: string) {
    return runsDb.nextSeq(this.pool, runId);
  }
  nextGeneration(runId: string) {
    return runsDb.nextGeneration(this.pool, runId);
  }
  listMessages(runId: string) {
    return runsDb.listMessages(this.pool, runId);
  }
  getToolResultMetadata(runId: string, toolCallId: string) {
    return runsDb.getToolResultMetadata(this.pool, runId, toolCallId);
  }
  listPayloads(runId: string) {
    return runsDb.listPayloads(this.pool, runId);
  }
  listGuildActivityRuns(guildId: string, since: Date, until: Date) {
    return activityDb.listGuildActivityRuns(this.pool, guildId, since, until);
  }
  listRunActivityStats(runIds: string[], since: Date) {
    return activityDb.listRunActivityStats(this.pool, runIds, since);
  }
  listRunGroupDeliveries(runIds: string[]) {
    return activityDb.listRunGroupDeliveries(this.pool, runIds);
  }
  listRunGroupPosts(runIds: string[]) {
    return activityDb.listRunGroupPosts(this.pool, runIds);
  }
  listRunActivitySteps(runIds: string[], since: Date) {
    return activityDb.listRunActivitySteps(this.pool, runIds, since);
  }
  listRunOpenings(runIds: string[], since: Date) {
    return activityDb.listRunOpenings(this.pool, runIds, since);
  }
  listGuildToolCallStats(guildId: string, since: Date, until: Date) {
    return activityDb.listGuildToolCallStats(this.pool, guildId, since, until);
  }
  listGuildToolCalls(guildId: string, tool: string, page: activityDb.GuildToolCallPage) {
    return activityDb.listGuildToolCalls(this.pool, guildId, tool, page);
  }
  listRunFileChanges(runIds: string[]) {
    return activityDb.listRunFileChanges(this.pool, runIds);
  }
  appendRunError(runId: string, entry: Record<string, unknown>, now: Date) {
    return runsDb.appendRunError(this.pool, runId, entry, now);
  }
  getGroupChatState(guildId: string) {
    return groupChatDb.getGroupChatState(this.pool, guildId);
  }
  updateGroupAgentMessageLimit(guildId: string, limit: number, now: Date) {
    return groupChatDb.updateGroupAgentMessageLimit(this.pool, guildId, limit, now);
  }
  listGroupMessages(guildId: string, options: { throughSeq?: number | null } = {}) {
    return groupChatDb.listGroupMessages(this.pool, guildId, options);
  }
  listGroupMessagesForActivity(guildId: string, since: Date, until: Date, afterSeq: number | null) {
    return groupChatDb.listGroupMessagesForActivity(this.pool, guildId, since, until, afterSeq);
  }
  listPendingGroupAgents(guildId: string, chatSeq: number) {
    return groupChatDb.listPendingGroupAgents(this.pool, guildId, chatSeq);
  }
  advanceGroupCursor(agentId: string, seq: number) {
    return groupChatDb.advanceGroupCursor(this.pool, agentId, seq);
  }
  clearGroupMessages(guildId: string, now: Date) {
    return groupChatDb.clearGroupMessages(this.pool, guildId, now);
  }
  listUnreadGroupChats(orgId: string, userId: string) {
    return groupChatDb.listUnreadGroupChats(this.pool, orgId, userId);
  }
  getGroupChatSeenThrough(guildId: string, userId: string) {
    return groupChatDb.getGroupChatSeenThrough(this.pool, guildId, userId);
  }
  markGroupChatSeen(guildId: string, userId: string, seq: number, now: Date) {
    return groupChatDb.markGroupChatSeen(this.pool, guildId, userId, seq, now);
  }
  appendGroupChatError(guildId: string, entry: Record<string, unknown>, now: Date) {
    return groupChatDb.appendGroupChatError(this.pool, guildId, entry, now);
  }
  listDueSchedules(now: Date) {
    return schedulesDb.listDueSchedules(this.pool, now);
  }
  markScheduleFired(scheduleId: string, now: Date, wake: PlannedWake) {
    return schedulesDb.markScheduleFired(this.pool, scheduleId, now, wake);
  }
  mergeRunMetadata(runId: string, extra: Record<string, unknown>, now: Date) {
    return runsDb.mergeRunMetadata(this.pool, runId, extra, now);
  }
  completeRun(runId: string, now: Date) {
    return runsDb.completeRun(this.pool, runId, now);
  }
  reopenRun(runId: string, now: Date) {
    return runsDb.reopenRun(this.pool, runId, now);
  }
  completeGroupDelivery(runId: string, agentId: string, throughSeq: number, now: Date) {
    return runsDb.completeGroupDelivery(this.pool, runId, agentId, throughSeq, now);
  }
  postUserGroupMessage(message: groupChatDb.NewUserGroupMessage, now: Date) {
    return groupChatDb.postUserGroupMessage(this.pool, message, now);
  }
  postAgentGroupMessage(message: groupChatDb.NewAgentGroupMessage, now: Date) {
    return groupChatDb.postAgentGroupMessage(this.pool, message, now);
  }
  updateRunSecrets(runId: string, secrets: Array<Record<string, string>>, now: Date) {
    return runsDb.updateRunSecrets(this.pool, runId, secrets, now);
  }
  updateRunScripts(runId: string, scripts: unknown[], now: Date) {
    return runsDb.updateRunScripts(this.pool, runId, scripts, now);
  }
  listActiveRunAgentIdsForSecret(secretId: string) {
    return secretsDb.listActiveRunAgentIdsForSecret(this.pool, secretId);
  }
  claimMonthlyStudioBuilderRun(
    orgId: string,
    now: Date,
    limit: number | null,
    client?: pg.PoolClient,
  ) {
    return usageDb.claimMonthlyStudioBuilderRun(client ?? this.pool, orgId, now, limit);
  }
  countGuildAgents(guildId: string) {
    return guildsDb.countGuildAgents(this.pool, guildId);
  }
  countOrgGuilds(orgId: string) {
    return orgsDb.countOrgGuilds(this.pool, orgId);
  }
  countServerConnections(serverId: string) {
    return mcpDb.countServerConnections(this.pool, serverId);
  }
  disconnectServerConnections(serverId: string, now = new Date()) {
    return mcpDb.disconnectServerConnections(this.pool, serverId, now);
  }
  deleteInstanceKey(integrationId: string) {
    return orgsDb.deleteInstanceKey(this.pool, integrationId);
  }
  countOrgAgents(orgId: string) {
    return orgsDb.countOrgAgents(this.pool, orgId);
  }
  countOrgBrowserAgents(orgId: string) {
    return orgsDb.countOrgBrowserAgents(this.pool, orgId);
  }
  countOrgCodingAgents(orgId: string) {
    return orgsDb.countOrgCodingAgents(this.pool, orgId);
  }
  getOrgMonthlyUsage(orgId: string, month: string) {
    return usageDb.getOrgMonthlyUsage(this.pool, orgId, month);
  }
  listOrgModelProviders(orgId: string) {
    return orgsDb.listOrgModelProviders(this.pool, orgId);
  }
  getOrgModelProvider(orgId: string, provider: string) {
    return orgsDb.getOrgModelProvider(this.pool, orgId, provider);
  }
  upsertOrgModelProvider(input: orgsDb.NewOrgModelProvider, now: Date) {
    return orgsDb.upsertOrgModelProvider(this.pool, input, now);
  }
  deleteOrgModelProvider(orgId: string, provider: string) {
    return orgsDb.deleteOrgModelProvider(this.pool, orgId, provider);
  }
  getOrgDefaultModel(orgId: string) {
    return orgsDb.getOrgDefaultModel(this.pool, orgId);
  }
  setOrgDefaultModel(orgId: string, model: string | null, now: Date) {
    return orgsDb.setOrgDefaultModel(this.pool, orgId, model, now);
  }
  getMcpServerBySlug(slug: string, orgId: string | null = null) {
    return connectorsDb.getMcpServerBySlug(this.pool, slug, orgId);
  }
  listConnectorSlugOwners(slug: string) {
    return connectorsDb.listConnectorSlugOwners(this.pool, slug);
  }
  countConnectorCalls(orgId: string, connectorId: string, month: string) {
    return connectorsDb.countConnectorCalls(this.pool, orgId, connectorId, month);
  }
  recordConnectorCall(orgId: string, connectorId: string, month: string, now: Date) {
    return connectorsDb.recordConnectorCall(this.pool, orgId, connectorId, month, now);
  }
  listConnectorCalls(orgId: string, month: string) {
    return connectorsDb.listConnectorCalls(this.pool, orgId, month);
  }
  countOrgConnectors(orgId: string) {
    return connectorsDb.countOrgConnectors(this.pool, orgId);
  }
  deleteConnector(serverId: string) {
    return connectorsDb.deleteConnector(this.pool, serverId);
  }
  insertConnector(connector: connectorsDb.NewConnector, now: Date) {
    return connectorsDb.insertConnector(this.pool, connector, now);
  }
  updateConnector(serverId: string, patch: connectorsDb.ConnectorPatch, now: Date) {
    return connectorsDb.updateConnector(this.pool, serverId, patch, now);
  }
  expireMcpTools(serverId: string) {
    return mcpDb.expireMcpTools(this.pool, serverId);
  }
  listTakenToolPrefixes() {
    return connectorsDb.listTakenToolPrefixes(this.pool);
  }
  insertAttachment(attachment: attachmentsDb.NewAttachment, now: Date) {
    return attachmentsDb.insertAttachment(this.pool, attachment, now);
  }
  getAttachment(id: string) {
    return attachmentsDb.getAttachment(this.pool, id);
  }
  listAttachmentsByIds(orgId: string, ids: string[]) {
    return attachmentsDb.listAttachmentsByIds(this.pool, orgId, ids);
  }
}
