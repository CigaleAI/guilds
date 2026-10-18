# Save a recipe

This page saves your guild as a recipe, then creates a second guild
from it.

A recipe is a guild's configuration as one file. It holds the agents,
their Tasks, their routines, and the tools they need. Keys, secret
values, and chat history stay on your box.

## 1. Save the guild

Open the guild's menu in its header. Click **Save as recipe**.

You should see the recipe's page. It shows the plan of everything the
recipe creates, and each agent's Task. The recipe is a draft.

## 2. Approve and export it

Click **Approve**. guilds.run checks the recipe. When the check
passes, the recipe is ready.

Click **Export**. Your browser downloads a JSON file. That file is
the recipe. You can send it to someone else.

## 3. Apply it

Click **Recipes** at the bottom of the sidebar. Click **Import JSON**
and pick the file you downloaded. The recipe's page opens.

Click **Approve and apply**. The preview shows what the apply
creates. Change **Guild name** to `research-2`, so the two guilds are
easy to tell apart. Click **Create guild**.

You should see a checklist. It lists what the new guild still needs
from you: logins, secret values, and outside setup. This recipe
needs none of those. Click **Activate routines**. That unpauses any
routine the recipe brought, and closes the checklist.

The new guild is in the sidebar, with the same agent, the same Task,
and the same routine.

## Good to know

- A recipe made from a guild with connectors asks for a login per
  connector during apply. You can reuse a login you have, or connect
  one afterwards.
- **From a guild** on the Recipes page captures any guild, not only
  the one you are in.
- The **Builder** drafts a recipe from a conversation instead.
  [Guild builder](../concepts/guild-builder.md) shows how.

[Recipes](../concepts/recipes.md) describes the file format and
every apply step.
