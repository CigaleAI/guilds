# guilds.run

guilds.run runs standing teams of AI agents you can inspect.

A guild is a department: named roles, a shared room, shared tables.
Every run keeps the prompt the model saw, every tool call, and every
memory change.

Agent-to-agent work opens uses of LLMs a single agent cannot cover,
and it accentuates the ways those models fail. guilds.run is the
framework Cigale built so that collaboration stays tractable.

System thinking used to belong to people who already wrote software.
With LLMs it is work anyone with a need or an interest can do, at a
different level of abstraction.

- **Deeply inspectable.** What the model sees is what you see.
- **Deeply customizable.** Each connection, each tool, and the model
  for each agent is chosen for the job.
- **Iterate till perfection.** A long-running multi-agent system is
  refined in place.
- **Share the love.** Recipes carry a working guild to someone who
  does not want to design one from scratch.

The longer account is [Philosophy](philosophy.md).

These pages are for the people who run it, the people who use it, and
the people who change it.

Each page describes what the code does today. The security register is
the one page that keeps history.

## Philosophy

- [Philosophy](philosophy.md) — why the product is shaped this way

## Getting started

Three pages, in order, take an empty machine to a working guild:

1. [Install](getting-started/install.md) — requirements, the three
   commands, what runs, where the state lives
2. [Model keys](getting-started/model-keys.md) — the welcome dialog:
   a provider, its models, the default; managing keys afterwards
3. [Your first guild](getting-started/first-guild.md) — a guild, an
   agent, its Task, the group chat, the run, memory, a routine, a
   tool, a recipe

Then, when the box needs it:

- [Configure](getting-started/configure.md) — platform keys, and
  `.env`: environment integrations, reaching the box, limits, the
  model catalog
- [Remote access](getting-started/remote-access.md) — reaching the
  box from another machine, with one operator or with accounts
- [Operate](getting-started/operate.md) — update, back up, restore,
  logs, when it fails

## Concepts

How the product works, for the operator.

- [Users and organisations](concepts/users-and-organisations.md) —
  identity modes, organisations, members, the instance admin, the seed
- [Guilds and agents](concepts/guilds-and-agents.md) — membership,
  configuration, avatars, deletion
- [Prompts and memory](concepts/prompts-and-memory.md) — the system
  prompt, the Task, memory, hydration
- [Notes and collections](concepts/notes-and-collections.md) — notes,
  display paths, collections, records, grants
- [Runs](concepts/runs.md) — direct, group, and schedule runs;
  generation; sandboxes
- [Group chat](concepts/group-chat.md) — tags, recipients, the cursor
  queue, posting
- [Secrets and access](concepts/secrets-and-access.md) — secrets,
  grants, what reaches a sandbox
- [Recipes](concepts/recipes.md) — portable guild configuration
- [Prompt Studio](concepts/prompt-studio.md) — improve standing tasks
  on a live guild
- [Guild builder](concepts/guild-builder.md) — design a recipe from a
  conversation
- [Operator app](concepts/operator-app.md) — the screens

## Tools and connectors

Native tools, the catalog, and the apps a box registers so agents
can reach Gmail, Drive, and GitHub.

- [Catalog](tools-and-connectors/catalog.md) — native and MCP
  catalogs, connections, bindings, what a run offers
- [Native tools](tools-and-connectors/native.md) — notes, tables,
  memory, browser, scripts, routines, secrets
- [Code tools](tools-and-connectors/code.md) — shell, files, search
- [Connectors](tools-and-connectors/connectors.md) — token logins
  and remote MCP
- [Gmail and Drive](tools-and-connectors/google.md) — the Google
  Cloud OAuth client
- [GitHub](tools-and-connectors/github.md) — the GitHub App
- [Registry](tools-and-connectors/registry.md) — connectors beyond
  the image

## Architecture

For the people who change the code.

- [System](architecture/system.md) — process model, topology, state on
  disk, images and stacks, the trust boundary
- [Code map](architecture/code-map.md) — repository layout, `src/`
  directories, boot, the request path, the run flow
- [Orchestrator](architecture/orchestrator.md) — startup and shutdown,
  events, PostgreSQL and migrations, codecs, the model client, the
  sandbox manager
- [Extension points](architecture/extension-points.md) — what an
  edition built on core may replace
- [Design system](architecture/design-system.md) — `@guildsrun/ui`:
  tokens, components, [Storybook](/storybook)
- [Security register](architecture/security-register.md) — issues
  fixed and still open, with their history

## Contributing

- [Contributing](CONTRIBUTING.md) — licence, pull requests, the check
- [Development](contributing/development.md) — the development stack,
  local state and reset, verify, check, the pre-push hook, CI,
  fixtures
- [Code guidelines](contributing/code-guidelines.md) — names, function
  size, scaffolding, boundaries, tests, docs

## Licence

guilds.run is made and operated by Cigale AI. It is free software
under the GNU Affero General Public License, version 3 only
([LICENSE](../LICENSE)). What it builds on is listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The hosted edition, the layer Cigale AI runs its own service with,
is separate and proprietary.
