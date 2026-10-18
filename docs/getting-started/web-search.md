# Give it web search

This page gives every agent on the box a web search tool.

Web search runs on a key from [Tavily](https://tavily.com). The box
holds that key for every organisation on it. A platform admin enters
it once. On a fresh box, you are the platform admin.

## 1. Get a key

Create an account at [tavily.com](https://tavily.com) and copy an API
key.

## 2. Enter it on the box

Open the account menu at the bottom of the sidebar. Click **Admin**.
Open **Platform keys**. Find **Web search**. Paste the key into
**Tavily API key** and click **Save**.

The key takes effect at once.

## 3. Check the agent has it

Click the agent in the sidebar. Open its **Tools** tab. Under the
integrations, **Tavily** is connected, and its tool `tavily_search`
is on.

## 4. Use it

Send a message in **Group chat** that needs the web:

```text
@researcher What is one news headline from today? Name the source.
```

The reply cites what it found. Click **Inspect run**. One step shows
a `tavily_search` call, with the query the agent chose and the
results it got back.

## Good to know

- Every agent on the box gets the tool. You can turn it off for one
  agent, one guild, or one organisation on their **Tools** tab.
- An organisation can connect a Tavily key of its own instead, under
  **Settings**, **Tools**. Its agents then run on that key.
- Web search is one of several platform keys.
  [Configure](../operations/configure.md#platform-keys) lists them all.

[Tools in a run](../tools-and-connectors/tools-in-a-run.md) explains
how tools reach a run.
