# guilds.run

![A row of guilds.run agent mascots](images/mascots.png)

guilds.run runs standing teams of AI agents you can inspect.

<a href="https://www.producthunt.com/products/guilds-run?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-guilds-run" target="_blank" rel="noopener noreferrer"><img alt="guilds.run - Create multi-agent workflows that you can trust | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1274741&amp;theme=light&amp;t=1791832617881"></a>

A guild is a team of agents. Each agent has a role, a model, and
tools. The team shares a chat, notes, and tables. Every run keeps
the prompt the model saw, every tool call, and every memory change.

## Get started

You need Docker. Run three commands:

```text
git clone https://github.com/CigaleAI/guilds.git && cd guilds
./setup.sh
docker compose up --detach --wait
```

Open `http://127.0.0.1:8080/`. Paste an API key from a model
provider. Build your first guild.

Three pages walk you through it, in order:

1. [Install](getting-started/install.md)
2. [Connect a model](getting-started/model-keys.md)
3. [Your first guild](getting-started/first-guild.md)

Then one short page each:

- [Add a routine](getting-started/add-a-routine.md) wakes the agent
  on a schedule.
- [Give it web search](getting-started/web-search.md) lets agents
  search the web.
- [Save a recipe](getting-started/save-a-recipe.md) saves the guild
  as one file and applies it again.

## Why guilds.run

Agent-to-agent work opens uses of LLMs a single agent cannot cover.
It also makes the ways those models fail harder to see. guilds.run
is the framework Cigale AI built so that collaboration stays
tractable.

- **Deeply inspectable.** What the model sees is what you see.
- **Deeply customizable.** Each connection, each tool, and the model
  for each agent is chosen for the job.
- **Iterate till perfection.** A long-running multi-agent system is
  refined in place.
- **Share the love.** Recipes carry a working guild to someone who
  does not want to design one from scratch.

[Philosophy](philosophy.md) says why the product is shaped this way.

## Find your way

Each page describes what the code does today. The security register
is the one page that keeps history.

| You want to | Read |
|---|---|
| Use it | [Get started](#get-started), then [Concepts](#concepts) |
| Run it for other people | [Run the box](#run-the-box) |
| Reach Gmail, Drive, or GitHub from an agent | [Tools and connectors](#tools-and-connectors) |
| Ask for a feature | [Feature requests](CONTRIBUTING.md#feature-requests) |
| Change the code | [Architecture](#architecture), then [Contributing](#contributing) |

## Run the box

- [Configure](getting-started/configure.md) — `.env`, platform keys,
  limits, the model catalog
- [Remote access](getting-started/remote-access.md) — reach the box
  from another computer
- [Operate](getting-started/operate.md) — update, back up, restore,
  logs, error messages

## Concepts

How the product works, for the operator.

- [Users and organisations](concepts/users-and-organisations.md) —
  identity, organisations, members, the instance admin
- [Model keys](concepts/model-keys.md) — providers, the welcome
  dialog, the Settings page, where keys live
- [Guilds and agents](concepts/guilds-and-agents.md) — membership,
  machines, configuration, deletion
- [Prompts and memory](concepts/prompts-and-memory.md) — the system
  prompt, the Task, memory
- [Notes and collections](concepts/notes-and-collections.md) — notes,
  tables, records, grants
- [Runs](concepts/runs.md) — direct, group, and schedule runs;
  the machine an agent runs on
- [Group chat](concepts/group-chat.md) — tags, recipients, posting
- [Secrets and access](concepts/secrets-and-access.md) — secrets,
  grants, what reaches a sandbox
- [Recipes](concepts/recipes.md) — a guild as one file
- [Prompt Studio](concepts/prompt-studio.md) — improve Tasks on a
  live guild
- [Guild builder](concepts/guild-builder.md) — design a recipe from a
  conversation
- [Operator app](concepts/operator-app.md) — every screen

## Tools and connectors

- [Catalog](tools-and-connectors/catalog.md) — native and MCP tools,
  what a run offers
- [Native tools](tools-and-connectors/native.md) — notes, tables,
  memory, browser, scripts, routines, secrets
- [Code tools](tools-and-connectors/code.md) — shell, files, search
- [Connectors](tools-and-connectors/connectors.md) — token logins
  and remote MCP
- [Gmail and Drive](tools-and-connectors/google.md) — the Google
  OAuth client
- [GitHub](tools-and-connectors/github.md) — the GitHub App
- [Registry](tools-and-connectors/registry.md) — connectors beyond
  the image

## Architecture

For the people who change the code.

- [System](architecture/system.md) — processes, state on disk,
  images, the trust boundary
- [Code map](architecture/code-map.md) — repository layout, boot,
  the request path, the run flow
- [Orchestrator](architecture/orchestrator.md) — startup, events,
  PostgreSQL, the model client, the sandbox manager
- [Extension points](architecture/extension-points.md) — what an
  edition built on core may replace
- [Design system](architecture/design-system.md) — `@guildsrun/ui`:
  tokens, components, [Storybook](/storybook)
- [Security register](architecture/security-register.md) — issues
  fixed and still open, with their history

## Contributing

- [Contributing](CONTRIBUTING.md) — licence, feature requests,
  pull requests, the check
- [Development](contributing/development.md) — the development
  stack, verify, check, CI, fixtures
- [Code guidelines](contributing/code-guidelines.md) — names,
  functions, boundaries, docs

## Licence

guilds.run is made and operated by Cigale AI. It is free software
under the GNU Affero General Public License, version 3 only
([LICENSE](../LICENSE)). What it builds on is listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The hosted edition, the layer Cigale AI runs its own service with,
is separate and proprietary.
