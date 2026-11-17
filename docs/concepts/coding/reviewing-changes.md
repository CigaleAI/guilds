# Reviewing changes

Every change a subscription agent's turn makes to a repository can be
reviewed from its run. The platform takes **checkpoints**: snapshots of
each working tree, uncommitted files included, around every turn of a
subscription agent that works in repositories ([Repositories](repositories.md#what-a-generation-does-with-them)).
The difference between two checkpoints is the diff the operator
reviews: what one harness turn changed.

Checkpoints are separate from the agent's own commits. The agent's
harness commits and pushes with its own tools, and the agent opens pull
or merge requests with its host's connector tools. Those go through the
project's usual review on its git host. A commit made by the agent's
[harness](harnesses.md) also names the run and the agent in its
message.

## Why it exists

An agent's work is only as trustworthy as what the operator can check.
A checkpoint records exactly what was on disk, whatever the agent
committed, stashed, or left uncommitted, without touching its branch or
its index. So the diff of a run is the authoritative link between a run
and a change. The commit trailers are the convenient one.

## How it works

### Checkpoints

A checkpoint is a commit of the working tree built through a temporary
index, recorded under a ref of the run. Uncommitted and untracked files
are included; ignored files are not. The current branch and the index
stay as they are.

- **Turn checkpoints.** Each turn of a subscription agent that picks
  repositories takes its own `start` in each of them before its CLI
  starts and its own `end` after the turn, under the turn's call id.
  The run records, for a turn that changed a repository, each
  repository it changed with its branch, its head commit, and the
  diffstat; a turn that changed nothing records nothing.

Checkpoints are local to the agent's clone. They are never pushed and
never deleted. Each keeps its commits from `git gc`, so they count
toward the agent's disk cap ([Agent home](../agent-home.md)).

### Diffs

A diff is computed on demand, on the agent's machine, waking it as the
**CLI** tab does. It is redacted with the agent's secret values and cut
at 256 KiB.

### Commit trailers

A commit made by a harness gets two trailers in its message:

```text
Guild-Run: <run id>
Guild-Agent: <agent id>
```

They are added in every repository, whatever hooks path it sets, and
the repository's own hooks still run. A commit made elsewhere, such as
from the **CLI** tab, gets none.

## In the app

### The Changes panel

On the **Chat** tab, a subscription agent's run ends with a **Changes**
panel once a turn has changed a repository. Each turn that did is under
**Turn `<n>`**, with a row per repository it changed: its name, its
branch, and its diffstat, such as "3 files · +40 −2". **Show diff**
fetches that turn's diff from the agent's machine, and **Hide diff**
folds it.

### Reading a diff

A diff shows added lines, removed lines, hunk headers, and file
headers in their own colours, with a copy button. "Loading the diff
from the agent's machine…" shows while it loads. A diff past the cap
ends with "The diff is cut at 256 KiB." A diff that cannot be loaded
shows "Couldn't load the diff" with the reason.

### Reviewing a run, step by step

1. Read the agent's final reply: what it changed, what it ran, and what
   failed.
2. Open the **Changes** panel and **Show diff** for each turn and repository.
3. Review the pull request the agent opened on the git host, where the
   project's own checks run.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Turn checkpoints | `start` and `end` around each turn of a subscription agent that picks repositories; recorded only for a turn that changed one |
| What is captured | Committed, uncommitted, and untracked files; not ignored ones |
| Where | Local refs in the agent's clone, never pushed, never deleted |
| Diff size | At most 256 KiB, then cut |
| Redaction | Every diff, with the agent's secret values |
| Trailers | On commits made by a harness |

## Reference

### Refs

| Ref | Written |
| --- | --- |
| `refs/guild/runs/<run id>/tasks/turn_<generation>_<run id>/start` | Before a subscription agent's turn starts, in each repository it picks |
| `refs/guild/runs/<run id>/tasks/turn_<generation>_<run id>/end` | After the turn ends, in each of them |

`guilds-code checkpoint` builds each snapshot: it copies the index to a
temporary one, runs `git add --all` against it, writes the tree, and
records a commit with `git commit-tree`, parented on `HEAD` when there
is one, as `guilds checkpoint <checkpoint@guilds.invalid>`, with the
message `guild run <run id> task <call id> start`.

A subscription agent's run stores `metadata.turn_changes`, one entry
per turn that changed a repository, in order:
`[{ call_id, generation, repos }]`, where `repos` holds each repository
the turn changed,
`{ name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions }`,
between the turn's own checkpoints. The run payload carries it as `turn_changes`.
A turn the restart cut short takes no end checkpoint and records
nothing.

### HTTP

```text
GET /api/runs/:id/turns/:call_id/changes/:repository/diff
                                              one subscription turn's start..end
```

- The diff returns `{ repository, diff, truncated }`. It runs
  `guilds-code diff`, which is `git diff --no-color --no-ext-diff`
  between the two refs, on the agent's machine, cut at 256 KiB and
  redacted with the agent's secret values.
- A turn the run did not record as changing the repository is 404
  ("that turn changed nothing in that repository").
- Missing checkpoints in the repository, or a failing `git diff`, is
  404. Secrets that cannot be read to redact the diff, or a box
  without generation, is 503.

### Commit trailers

A harness's environment sets `core.hooksPath` to the image's
`/usr/local/share/guilds/git-hooks`, as the next `GIT_CONFIG_KEY_<n>`
and `GIT_CONFIG_VALUE_<n>` after the image's own entries
([Harness environment](harnesses.md#harness-environment)). git reads
those after every configuration file, so they win over a repository's
own `core.hooksPath`; only `git -c core.hooksPath=...` on one command
wins over them. The CLI tab's environment does not set it.

Every hook name git looks up in a hooks directory (those of
githooks(5) but `fsmonitor-watchman`, which `core.fsmonitor` names by
its path) is a link to `guilds-hook`. It first finds the repository's
own hooks directory as git would without the platform's: the last
`core.hooksPath` of the system, global, local, or worktree
configuration, with `~` expanded and a relative path taken from the
directory git runs hooks in, else `hooks` in the repository's common
git directory, which its worktrees share. A hooks directory that is
the platform's own counts as none. When that directory has an
executable hook of the name, `guilds-hook` runs it with git's
arguments, standard input, environment, and working directory, and
exits with its status, so a failing hook still fails the command. The
environment keeps the platform's `core.hooksPath`, so git that the hook
runs goes through the platform's hooks too. A
missing or non-executable one is no hook, as for git, which for
`push-to-checkout` means updating the checked-out branch's working tree
as git does itself.

`prepare-commit-msg` runs the repository's hook first, then, when
`GUILD_RUN_ID` is set, `git interpret-trailers` with
`--if-exists addIfDifferent`; `Guild-Agent` falls back to `unknown`.
Run after the repository's hook, the trailers stay in the message's
last paragraph, where git reads trailers. `--no-verify` skips
`pre-commit` and `commit-msg`, not `prepare-commit-msg`.

git removes `GIT_CONFIG_COUNT` from the environment of the
`receive-pack` it starts for a push to a repository on the same
machine, so that repository runs its own hooks, without the
platform's.

### Code

`runtime/guilds-code` (`checkpoint`, `diff`),
`runtime/git-hooks/guilds-hook`, `runtime/guilds-harness` (the
harness's environment),
`apps/orchestrator/src/generation/coding.ts` (a subscription turn's
checkpoints, and reading a diff from the machine),
`apps/orchestrator/src/generation/run-review.ts` (which diff a request
names), `apps/orchestrator/src/http/coding-routes.ts`, and in the app
`apps/web/src/features/agent/chat/ChangesPanel.tsx` (the panel and the
diff view), and `apps/web/src/features/agent/chat/changes.ts` (the
diffstat and line colours).
