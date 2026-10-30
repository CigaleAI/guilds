import { credentialFix, HARNESS_INFO, harnessesOn, harnessOffMessage, isHarnessOff } from "../coding/harnesses.js";
import type { Harness } from "../db/schema/index.js";
import { checkCallId, harnessOp, opsRun, stringOrNull } from "./harness-ops.js";
import type { ToolServices } from "./services.js";
import type { ToolRun } from "./types.js";

/** Why a harness cannot run: none is picked, its CLI is missing from the image, or it has no credential. */
export class HarnessSetupError extends Error {
  constructor(
    readonly code: "harness.missing" | "harness.off" | "harness.not_installed" | "harness.credential",
    message: string,
  ) {
    super(message);
    this.name = "HarnessSetupError";
  }
}

/** What a coding run or a `code_task` call of an agent with no harness picked fails with. */
export function harnessMissingError(): HarnessSetupError {
  const labels = harnessesOn().map((harness) => HARNESS_INFO[harness].label);
  const choices = labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}` : labels.join("");
  return new HarnessSetupError("harness.missing", `no harness is picked: choose ${choices} in the agent's Settings`);
}

/** The run's harness; throws `HarnessSetupError` when none is picked or it is off. */
export function requiredHarness(run: ToolRun): Harness {
  if (run.harness === null) {
    throw harnessMissingError();
  }
  if (isHarnessOff(run.harness)) {
    throw new HarnessSetupError("harness.off", harnessOffMessage(run.harness));
  }
  return run.harness;
}

function assertInstalled(harness: Harness, meta: Record<string, unknown>): void {
  if (meta.installed === true) {
    return;
  }
  const fix =
    harness === "codex"
      ? "rebuild the runtime image, which always installs it"
      : `build the runtime image with HARNESSES naming ${harness}`;
  throw new HarnessSetupError(
    "harness.not_installed",
    `${HARNESS_INFO[harness].label} is not installed in this machine's image: ${fix}`,
  );
}

async function assertCredential(
  services: ToolServices,
  run: ToolRun,
  harness: Harness,
  meta: Record<string, unknown>,
): Promise<void> {
  if (meta.credential === "login") {
    await services.db?.markHarnessLogin(
      run.agent_id,
      { harness, account: stringOrNull(meta.account) },
      new Date(),
    );
  } else if (meta.credential !== "secret") {
    await services.db?.clearHarnessLogin(run.agent_id, harness);
    throw new HarnessSetupError(
      "harness.credential",
      `${HARNESS_INFO[harness].label} has no credential: ${credentialFix(harness, run.secret_aliases)}`,
    );
  }
}

/** Checks the harness's CLI is installed and has a credential; returns its version. */
export async function checkHarness(
  services: ToolServices,
  run: ToolRun,
  callId: string,
  harness: Harness,
): Promise<string | null> {
  const check = await harnessOp(opsRun(run), callId, "check", { harness });
  assertInstalled(harness, check.meta);
  await assertCredential(services, run, harness, check.meta);
  return stringOrNull(check.meta.version);
}

/**
 * Checks, before a coding generation calls its model, that the run's harness is installed and
 * has a credential, so a run that cannot delegate code work fails at start. Throws
 * `HarnessSetupError` naming the fix.
 */
export async function assertHarnessReady(services: ToolServices, run: ToolRun): Promise<void> {
  const harness = requiredHarness(run);
  await checkHarness(services, run, checkCallId(), harness);
}

/** What a harness check found on the agent's machine. */
export type HarnessCheck = {
  installed: boolean;
  version: string | null;
  /** What the harness would run on: a granted secret, a login in the home, or nothing. */
  credential: "secret" | "login" | null;
  /** Whose the login is, as the harness recorded it; null without a login or when unknown. */
  account: string | null;
};

/** Runs `guilds-harness check` for `harness` in `run`, outside any tool call. */
export async function checkHarnessOn(run: ToolRun, harness: Harness): Promise<HarnessCheck> {
  const check = await harnessOp(opsRun(run), checkCallId(), "check", { harness });
  const credential = check.meta.credential;
  return {
    installed: check.meta.installed === true,
    version: stringOrNull(check.meta.version),
    credential: credential === "secret" || credential === "login" ? credential : null,
    account: stringOrNull(check.meta.account),
  };
}
