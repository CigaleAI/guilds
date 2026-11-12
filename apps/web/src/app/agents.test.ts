import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../api/types/issues";
import { agentLook, agentStateOf } from "./agents";

test("a styled shape draws that style in the identity colour", () => {
  assert.deepEqual(agentLook({ avatar_shape: "critters:ab12", avatar_color: "#7c5cff" }), {
    tone: "dusk",
    src: "/avatars/critters.svg?seed=ab12&color=8672a0",
  });
  assert.equal(
    agentLook({ avatar_shape: "bottts-neutral-zz9", avatar_color: "#1fafd1" }).src,
    "/avatars/bottts-neutral.svg?seed=zz9&color=1fafd1",
  );
  assert.equal(
    agentLook({ avatar_shape: "cutouts:paper-1", avatar_color: "#1fafd1" }).src,
    "/avatars/cutouts.svg?seed=paper-1&color=1fafd1",
  );
  assert.equal(
    agentLook({ avatar_shape: "voxel-bot:cube-9", avatar_color: "#7c5cff" }).src,
    "/avatars/voxel-bot.svg?seed=cube-9&color=8672a0",
  );
});

test("a bare seed is clay; an empty shape shows initials", () => {
  assert.equal(
    agentLook({ avatar_shape: "teardrop", avatar_color: "#a3e635" }).src,
    "/avatars/clay.svg?seed=teardrop&color=7f9a5e",
  );
  assert.deepEqual(agentLook({ avatar_shape: "", avatar_color: "#fbbf24" }), { tone: "ochre" });
});

test("an agent's state is disabled while a blocking issue stands, else running or idle", () => {
  const disabling: Issue = {
    id: "iss_1",
    guild_id: "guild_1",
    agent_id: "agent_1",
    agent_name: "scout",
    run_id: null,
    kind: "api",
    severity: "blocking",
    status: "open",
    summary: "Login revoked",
    detail: "401",
    tool_name: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    agent: null,
  };
  assert.equal(agentStateOf({ generating: false }, disabling), "disabled");
  assert.equal(agentStateOf({ generating: true }, disabling), "disabled");
  assert.equal(agentStateOf({ generating: true }, undefined), "running");
  assert.equal(agentStateOf({ generating: false }, undefined), "idle");
});
