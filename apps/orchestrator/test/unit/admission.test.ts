import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionConflictError, AdmissionCoordinator } from "../../src/admission/coordinator.js";

test("admission counts agent and studio workloads against the same org ceiling", async () => {
  const admission = new AdmissionCoordinator();
  await admission.acquire("agent", "a_1", "org_1", 2);
  await admission.acquire("studio", "stu_1", "org_1", 2);
  await assert.rejects(
    () => admission.acquire("studio", "stu_2", "org_1", 2),
    (error: unknown) => error instanceof AdmissionConflictError && error.message.includes("concurrent"),
  );
  assert.equal(admission.isBusy("agent", "a_1"), true);
  assert.equal(admission.isBusy("studio", "stu_1"), true);
  assert.equal(admission.isBusy("agent", "stu_1"), false);
  admission.release("studio", "stu_1");
  await admission.acquire("studio", "stu_2", "org_1", 2);
  assert.equal(admission.orgCount("org_1"), 2);
});

test("the same studio session cannot acquire twice", async () => {
  const admission = new AdmissionCoordinator();
  await admission.acquire("studio", "stu_1", "org_1");
  await assert.rejects(
    () => admission.acquire("studio", "stu_1", "org_1"),
    (error: unknown) =>
      error instanceof AdmissionConflictError && error.message === "studio session is already generating",
  );
});
