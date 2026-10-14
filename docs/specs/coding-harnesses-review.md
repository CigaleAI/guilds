# Code review: `feat/coding-harness`

Reviewed against [Contributing](../CONTRIBUTING.md) and
[Code guidelines](../contributing/code-guidelines.md), and checked
against the draft spec in this folder.

| | |
|---|---|
| Branch | `feat/coding-harness` (`fb4ef03`) |
| Base | `main` (`ca45b04`) |
| Scope | 97 files, +4816 / −1184 |
| Commits | 4, one per delivery step |
| Verdict | **Request changes** |

This review did not run `make check`. The harness, generation,
validation, and recipe-apply unit tests pass on the tip: 151 tests,
0 failures.

---

## What the branch does

A coding agent no longer edits the tree itself. It delegates that
work to a harness that runs in its sandbox on the operator's
subscription: Claude Code, Codex, or Cursor.

`code_task` starts `guilds-harness` detached, polls it, streams
progress, and returns the final message, a session id, and a
diffstat. Native edit and code-graph tools are gone. Graft and
ast-grep leave the image. A stored coding agent without a harness
is deprecated and cannot start a coding run.

The four commits match the spec's delivery plan and each state an
outcome. That satisfies "one change does one thing" at commit
scope. The pull request is still one feature, as the spec asks:
it merges after the native tools are gone.

Tool calls in a turn run one after another, so two `code_task`
calls never share the run's single `harness_task` record.

---

## Guidelines checklist

From
[Code guidelines § Checklist](../contributing/code-guidelines.md#checklist)
and [Contributing](../CONTRIBUTING.md).

| Rule | Result |
|---|---|
| Functions short: ≤30 lines, ≤3 branches, ≤3 parameters, nesting ≤2 | **Fail.** The new `code_task` handler is ~160 lines with 50+ branches. Several other new functions are over the limits. No lint rule checks these limits (see §2). |
| Every new branch has a unit test | **Fail.** Happy path, timeout, cancel, missing state, the three drivers, and a helper-level supervisor are covered. Documented branches are not: failed polls, a throw after `start`, the task-diff route, `clipProgressLine`, empty brief, no repositories, `timeout_minutes` clamp, SIGKILL after the grace period. No automated test runs a real CLI (see §8). |
| Searched for existing code before writing new code | **Mostly.** `runCodeHelper`, checkpoints, redaction, recipe apply, and Settings follow the code and browser paths already in the tree. `_run_dir` and its pruning are copied from `guilds-code` (see §14). |
| Names are clear and do not overlap | **Pass.** |
| Shared code in `lib/` meets the shared-code rules | **Pass.** Harness ids live in `coding/`; the web copy of the labels is a second use, not a third. |
| Side effects are at the edges | **Pass** on the new domain helpers (`harnessOf`, `assertHarnessChosen`, `buildBrief` once notes are loaded, `codeTaskText`). The poll loop is an edge and belongs there. |
| Docs updated in the same change | **Mostly.** Concept, tools, operator-app, runs, recipes, and the security register were rewritten. The docs index and the system page still describe code tools as they were. |
| Lint and tests pass | **Partly.** `make check` was not run. The four unit files the branch touches most pass (151 tests). |
| One change, one thing | **Pass** at commit scope. The PR is large because the spec merges only after step 3. |
| Security register entry when a security issue is found or fixed | **Pass.** SEC-27 to SEC-31 are new. SEC-9 is fixed. SEC-8 now names `code_task`. |

A pull request whose check passes is ready for review
([Contributing](../CONTRIBUTING.md)). Run `make check` on the tip
before the next review.

---

## Must fix

### 1. A harness can keep running after `code_task` returns

`apps/orchestrator/src/toolbox/harness.ts`, `codeTask.handler`.

The spec and `docs/tools-and-connectors/code.md` say a harness
never keeps running with nobody polling it. Orchestrator restart
honours that: reconcile calls `stop`. The handler does not, on
two paths.

**A throw after `start`.** Nothing after
`harnessOp(ops, "start", …)` is in a `try/finally`. A throw from
`remember()` (a database write), from `publish_progress`, or from
a `start` exec that failed after the supervisor launched leaves
the CLI running. The call then commits an error result, so it is
not pending at restart and reconcile never stops it.

**Three failed polls.** After `POLL_FAILURES_MAX` (3) failed
`poll` execs, the loop sets `status = "interrupted"` and `break`s
without `stop`. Poll can fail while the supervisor is alive: a
helper timeout, a bad envelope, a transient sandbox exec error,
or `before_command` failing to refresh the GitHub token, since it
runs inside the same `try`. The result then says the machine
restarted, which may be false.

Once `start` has been sent, call `stop` in a `finally` unless the
loop saw a clean `exited` or `missing`. Word the failed-poll
detail as "the harness stopped answering", and keep "the machine
restarted" for `poll.meta.missing`. Add unit tests for a throw
after `start` and for three failed polls; each asserts `stop`.

### 2. `codeTask.handler` breaks the function rules

`codeTask.handler`, about lines 294–456.

The guidelines cap a function at 30 lines, 3 branches, 3
parameters, and 2 levels of nesting. This handler is about 160
lines. It validates arguments, checks the CLI and credential,
builds the brief, takes the start checkpoint, starts the harness,
polls, publishes progress, handles cancel / timeout / missing
state / poll failures, reads the result, takes the end
checkpoint, and assembles metadata.

That is several behaviours in one function. A nested condition,
a loop with a branch inside, or a second decision tree should
become a named function. See
[Suggested split for the handler](#suggested-split-for-the-handler).
Do not split into pieces that only exist to pass the counter.

Nothing checks these limits: neither `eslint.config.js` has
`complexity` or `max-lines-per-function`, and there is no Python
linter configuration. This finding is against the written
guideline, not CI, and `main` already carries functions over it
(`runCodeHelper`, see §13). Split the handler, because §1 needs
the `try/finally` it yields. The rest is judgment.

The same limits apply to new Python. In
`runtime/guilds-harness`, `op_start` (~74 lines), `op_stop`
(nesting 4), `supervise`, and `_events` need the same treatment.
`_interrupted_code_task` in `apps/orchestrator/src/generation/index.ts`
is ~55 lines and takes 4 parameters.

### 3. Docs that still describe the old code tools

A change to behaviour updates the page that describes it, in the
same change.

`docs/README.md` still indexes code tools as "shell, files,
search". The page now centres on `code_task` and a harness. A
reader should find `code_task` from the front page.

`docs/architecture/system.md` still says a coding agent's code
tools run inside the container. It should name `code_task` and
`guilds-harness`, and that the harness runs on a subscription
token or a login, not an organisation model key.

---

## Should fix

### 4. The handler ignores what `stop` returns

On cancel and timeout the handler sets `stopped = true` and
reports "Stopped" without reading `meta.exited`.

`op_stop` returns `exited: false` when the process group outlives
SIGKILL. The realistic case is a CLI whose children called
`setsid` and left the group. A missing pid is rare: `start` waits
up to 5 s for the pid file before it returns
(`runtime/guilds-harness:690`). `PermissionError` cannot happen as
root (SEC-6).

Read `meta.exited`. When it is false, say the harness did not
stop and name its log.

### 5. Untested branches in new code

"Every branch in new code has a unit test."
`test/unit/harness.test.ts` is strong on the happy path, on the
three drivers, and on a supervisor that outlives the call that
started it (a helper-level test of `start`, `poll`, `stop`, and
`result`). These branches have no test:

| Branch | Where |
|---|---|
| Throw after `start` → `stop` | `toolbox/harness.ts` |
| Three failed polls → `interrupted` and `stop` | `toolbox/harness.ts` |
| `stop` that returns `exited: false` | `toolbox/harness.ts`, `op_stop` |
| Empty or missing `brief` | `codeTask.handler` |
| `notes` not a list of strings | `notePaths` |
| Guild has no repositories | `repositoryFor` |
| `timeout_minutes` clamp (default 30, max 60) | `timeoutMinutes` |
| Checkpoint failure (warn, null shas) | `checkpoint` |
| `result` missing after a non-interrupt stop | handler |
| `clipProgressLine` after redaction | `generation/index.ts` publish path |
| `GET /api/runs/:id/tasks/:call/diff` | `http/coding-routes.ts` |
| SIGKILL after the 10s grace when SIGTERM is ignored | `runtime/guilds-harness` `op_stop` |

`GET /api/agents/:id/harness` has an integration assertion in
`test/integration/machines.test.ts`. The task-diff route has
none.

`HarnessCredentials` has no test for the copy it shows: granted
secret, login last seen, CLI off, load error.

### 6. Apply preview omits the terms note

Settings and Create agent say a personal subscription in a
shared organisation may fall outside the vendor's terms
(SEC-30). The apply preview harness picker
(`ApplyPreviewPage.tsx`) only says "It runs on your own
subscription."

Show the same sentence wherever a harness is chosen.

### 7. Interrupted calls leave state behind, and reconcile takes no end checkpoint

Neither the failed-poll path in the handler nor
`_interrupted_code_task` calls `result`, which is what clears a
call's state files under `/run/guilds/<agent>/harness` and deletes
the 0600 `.prompt.md` that holds the brief and its notes. Both
stay until the run folder is pruned.

The handler does take the end checkpoint on that path
(`harness.ts:424` runs for every status). Reconcile does not: an
orchestrator restart leaves the row without `end_sha`, so Diff
returns 404 for that task although the working tree may hold its
changes.

Call `result` once `stop` reports `exited`, on both paths. Take
the end checkpoint in `_interrupted_code_task`.

### 8. No automated test runs a real CLI

`test/contract/harness.test.ts` has a live turn per harness. It
skips unless the credential is in the environment and the runtime
image is built, so CI never runs it. Every driver flag — Claude
Code's `--setting-sources ""` and `--disable-slash-commands`,
Codex's `--ignore-user-config`, `--ignore-rules`, and `--disable …`,
Cursor's `--resume=` — is exercised only by the stub, which accepts
anything. The spec says the flags "must be confirmed against the
pinned version."

Run the live Codex turn on the tip, the one harness a published
image carries, and put the result in the pull request. Run all
three when the credentials exist.

### 9. Provider-switch variables stay in the harness environment

`ClaudeCode.removed_env` drops `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL`, not
`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`. An agent
granted those for other work runs its harness on metered Bedrock
or Vertex, which is what the list exists to prevent.

Add them to `removed_env`, and extend the "no API key" driver
test to assert they are gone.

---

## Consider

### 10. A cancel is not seen before the harness starts

`check`, `buildBrief`, and the start checkpoint (up to 300s) run
on `opsContext`, which has no `cancel_event`. A run cancelled in
that window still starts the harness, then stops it on the first
pass of the loop. Check `ctx.cancel_event?.aborted` before
`start`.

### 11. A resumed session is not bound to its repository

The spec says a session resumes only in the repository it
started in. `repositoryFor` requires `repo` when the guild has
more than one repository, for every call. That covers the
"session_id plus several repos" case.

Nothing checks that this `session_id` started in that
repository. The agent can resume a session with the working
directory of another repo. There is no session registry; the
harness keeps its own state.

If that binding matters, store `session_id → repository` when
the session first appears, and refuse a mismatch. If the agent
is trusted to pass the pair, say so in `docs/tools-and-connectors/code.md`.

### 12. Task diff loads every message of the run

`GET /api/runs/:run_id/tasks/:call_id/diff` calls `listMessages`
and finds the `code_task` row by walking the array. The run view
already loads the whole transcript the same way, so this is not
new cost in kind. The larger cost is that a GET wakes the machine
for `guilds-code diff`.

If a lookup by run and tool-call id exists or is cheap to add,
use it.

### 13. Smaller function-limit misses

Not as large as the handler, still over the written limits:

- `codeTaskText`, `failureDetail`, `buildBrief` (loop with a
  branch inside)
- `runCodeHelper` (4 parameters, ~8 branches) — 4 parameters
  already on main; `helper` joined the options object
- `HarnessCredentials` (4 props, ~8 branches)
- `ToolCallDetail` (5 props, the result pane is a nested
  ternary)
- `applyToolProgress` (~6 branches)
- `validateMechanical` was already large; the new harness block
  adds more branches inside the role loop

Fix these when the handler is split. Do not grind every 20-line
formatter into three files.

### 14. Run-folder pruning is copied, and the log path dangles

`_run_dir` and `KEEP_RUNS = 20` exist in both `guilds-code` and
`guilds-harness`, and both prune `~/.runs`. Two copies of one
rule drift.

The `log:` line in a `code_task` result names
`.runs/<run>/<call>.harness.jsonl`, which is gone after 20 later
runs. Say so in `docs/tools-and-connectors/code.md`.

### 15. `operate.md` parentheses

`docs/getting-started/operate.md` is not in the three-step Get
started list, but it is a how-to page. The new harness paragraph
uses parentheses (`claude-code cursor`, its default). The
tutorial rules ban parentheses and file-path tone where a
concept page can hold the depth. Move the build-arg detail to
[Code tools](../tools-and-connectors/code.md) and keep one
imperative step here.

### 16. Progress does not survive a reload

`publish()` (`generation/index.ts:1275`) writes `tool.progress`
to in-memory subscriber queues; the web keeps the last 200 lines
in memory. Reload the run view during a long call and the card is
empty until the result lands.

Merge the last lines into run metadata next to `harness_task`,
one write per poll, or say in
[Operator app](../concepts/operator-app.md) that progress is
live only.

### 17. The credential helper could be withheld from the harness

SEC-28 says the preamble is the only control on `git push`. There
is a technical one. The helper reaches git through
`GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_*` (`runtime/Dockerfile:169`)
on top of the system config. With `GIT_CONFIG_COUNT=1` and the
reset entry alone in the harness's environment, git inside the
harness has no GitHub token: a push fails instead of being
discouraged. The cost is no `git fetch` from the harness either;
the agent fetches with `shell` before delegating.

The spec keeps the helper on purpose. This is the operator's
call: take the control, or record in SEC-28 why the helper stays.

### 18. Checkpoint refs are never deleted

`guilds-code` writes `refs/guild/runs/…` with `update-ref` and
never removes one. Run refs were two per run; task refs are two
per `code_task`. Each pins its commits against `git gc`, and the
objects count toward `max_workspace_mib`. The pattern predates
this branch; the branch multiplies it. Prune alongside
`_prune_runs`, or say so in
[Code tools](../tools-and-connectors/code.md).

### 19. `.stopped` is written and never read

`op_stop` touches the marker and `op_result` reports it as
`meta.stopped` (`runtime/guilds-harness:857`). The handler never
reads it. Drop the marker, or use it in `failureDetail` to tell a
stop from a crash.

---

## Spec vs code

The committed docs and the code agree with each other more than
they agree with the draft spec. That is the right direction:
docs describe what is. The spec is stale in two places.

| Spec | Code and committed docs |
|---|---|
| Claude `--setting-sources user` | `""`, plus a home reset before every call. SEC-29 records this. |
| `repo` required when `session_id` and several repositories | `repo` is required whenever there are several repositories. Stricter, and enough. |
| Helper tests for stop, timeout, supervisor | Supervisor and stop have a helper-level test. Timeout is covered through `code_task`. SIGKILL escalation has none. |
| Delivery step 3 before merge | Done in this branch: native tools removed, Graft gone, harness list on the machine |

No need to change the code to match the spec's older Claude
flags. Neither the spec nor this review belongs under `docs/`:
[AGENTS.md](../../AGENTS.md) says a page there describes what is,
never a specification or a to-do list. Keep `docs/specs/` out of
the merge; the review goes in the pull request.

---

## What works well

The design matches the philosophy pages: the agent stays the
lead, the run records the brief and the result, the harness does
not get notes or MCP of its own.

The `coding` block in `apps/orchestrator/src/prompts/system.md`
matches the spec: self-contained brief, resume with
`session_id`, questions to the operator, check then push,
harness output is data.

Validation is in the domain, not in the route:
`assertHarnessChosen` allows a stored coding agent without a
harness to save other settings, and refuses a create or a change
that leaves coding on with no harness. Tests name that
behaviour.

Recipe apply refuses to create while a coding role has no
harness. Validation warns, and never refuses, when the
credential cannot be known before apply.

The runtime image always installs Codex. Claude Code and Cursor
are behind `HARNESSES`. The published image workflow sets
`HARNESSES=` and `BROWSER=chromium`. Drivers fail with a fix
when the CLI is missing. Settings marks those harnesses
unavailable once the machine has reported its list.

`guilds-harness` is careful where it matters:

- prompt on stdin or in a 0600 file, never as prompt text on the
  argv
- `GH_TOKEN` and `GITHUB_TOKEN` dropped; API-key variables that
  would switch a harness to metered billing dropped per driver
- state dir mode 0700; call ids and repository names validated
- `reset()` refuses to follow a symlink out of the home
- login and session files are not in `local_state`
- stop is SIGTERM, then SIGKILL after 10s, on the CLI's process
  group
- the supervisor is its own session and ignores SIGHUP

Progress lines are redacted with the run's secrets, then clipped,
so a secret is not cut in two.

The security register entries (SEC-27 to SEC-31) are complete:
where, exposure, control, residual. SEC-9 is marked fixed
because Graft left the image. SEC-31 is accepted with a reason
an operator can act on (pick Claude Code or Codex).

The operator app follows the existing Settings and run-view
patterns: a required Harness select, a deprecation banner that
focuses the select, live `tool.progress`, a task diff pane.

---

## Architecture

The shape holds and does not need pushing back on: the harness is
a tool, one call is one headless turn, a detached supervisor is
polled by short execs, and the agent stays the lead. State under
`/run/guilds` dies with the container, the prompt never reaches
argv, and user-level configuration is reset before every call.

Three things to hold in mind:

- The test seam is the weak point, not the code. The stub proves
  the orchestrator side; nothing proves the three CLIs accept
  what they are given (§8).
- Exec-per-poll is a trade against one long-lived streaming exec:
  up to 1,200 execs an hour per call, each with a `before_command`
  and a `publish`. Fine today; the first knob to turn if machines
  get busy. Not a change request.
- On session binding (§11), take the "agent is trusted" branch.
  The harness owns the session state; a registry in the
  orchestrator would be a second source of truth it cannot
  verify.

The single `harness_task` record per run holds:
`generation/index.ts:1302` refuses a second generation on an
agent with a 409, and tool calls in one generation run in
sequence. Reconcile runs `stop` through `_maintenance_ctx`, which
carries `GUILDS_AGENT_HOME`, so the helper finds the right state
directory.

---

## Residual risk (already registered)

These are not new findings. They are the ones a reviewer should
still hold in mind.

- SEC-28: the harness can still `git push` through the credential
  helper. `GH_TOKEN` is unset; git is not. The only control is
  the preamble and the agent's check-then-push prompt. §17 names
  a technical one.
- SEC-27: a login file's values are not in the redaction set.
  Reading the file back shows them in the transcript.
- SEC-31: Cursor runs a repository's `.cursor/hooks.json`.
- SEC-24: every agent on the machine can read the others'
  harness logins.

The register already says this. No extra entry is needed.

---

## Suggested split for the handler

Keep the names in `toolbox/harness.ts`. Do not add a
`helpers/` folder.

```text
handler
  → assertCodeTaskReady(ctx, args)      // harness, brief, repo, check, credential
  → startHarnessTurn(ctx, ready)        // brief, checkpoint start, cancel check, start, remember
  → try
      pollHarnessUntilSettled(ctx, turn)  // cancel / timeout / poll / progress
    finally
      stop unless settled cleanly         // reads stop's exited
  → finishHarnessTurn(ctx, turn)        // result, checkpoints, outcome text
```

The `finally` is what makes §1 hold: every exit after `start`
calls `stop`, except `missing` (nothing to stop) and a clean
`exited` from poll.

---

## Test plan before the next review

- [ ] `stop` runs in a `finally` after `start`; failed polls and a
      throw after `start` both stop the harness.
- [ ] Failed polls do not claim the machine restarted unless
      `poll.meta.missing` is true.
- [ ] The handler reads `stop`'s `exited` and says when the
      harness did not stop.
- [ ] Split `codeTask.handler` and the largest `guilds-harness` ops
      so new functions meet the line, branch, parameter, and
      nesting limits.
- [ ] Unit tests for the rows in §5.
- [ ] `docs/README.md` and `docs/architecture/system.md` describe
      the harness.
- [ ] Apply preview repeats the SEC-30 sentence.
- [ ] Interrupted calls call `result`; reconcile takes the end
      checkpoint.
- [ ] The live Codex turn passes on the tip, and its output is in
      the pull request.
- [ ] `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` leave
      the harness environment.
- [ ] `make check` on the tip.

Manual, after check:

1. Create a coding agent with no harness: Settings shows the
   notice; a coding run fails with `coding.harness_missing`.
2. Pick Codex (or Claude Code on an image that has it), grant or
   log in, run `code_task`: progress streams, result shows
   session and diffstat, Diff opens the task diff.
3. Cancel a running `code_task`: status `cancelled`, process
   gone.
4. Restart the orchestrator during a turn: status `interrupted`,
   session named, harness not left running.
5. Apply a recipe with a coding role: Create guild waits for a
   harness; the created agent has it.
6. On a published-style image (`HARNESSES=`): Claude Code and
   Cursor are unavailable; Codex is not.
