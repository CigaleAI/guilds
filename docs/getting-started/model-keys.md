# Model keys

Agents run on your organisation's own key for a model provider. The
server holds none: nothing in `.env` names a model, and no
integration serves one. Until a provider is connected nothing can
run, and the app waits on the welcome dialog.

This page connects the first provider. What you need is a key from
one provider, or a local server that speaks the OpenAI API. The
dialog takes three steps: paste the key, tick the models your agents
may use, and mark one as the default.

## Pick a provider

| Provider | Models | Key from | Cost shown |
|---|---|---|---|
| OpenAI | GPT models, straight from OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Yes |
| OpenRouter | Hundreds of models behind one key, Claude and Gemini included | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | Yes |
| xAI | Grok models | [console.x.ai](https://console.x.ai/) | Yes |
| DeepInfra | Open-weight models, priced low | [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys) | Yes |
| Local endpoint | Ollama, LM Studio, vLLM, or any OpenAI-compatible server you run | None required | No |
| Kimi Code | Kimi models on a Kimi Code plan, for coding agents | [kimi.com/code](https://www.kimi.com/code) | No |

Any one of the first five is enough for the whole of
[Your first guild](first-guild.md). One OpenRouter key reaches models
from several makers; a local endpoint needs no account at all.

The first five are **Marketplace** providers: agents, Studio, and the
Builder run on them. Kimi Code is a **Coding API**: its models are
offered only to an agent with **Coding** on, cannot be the default,
and are not used by Studio or the Builder.

The provider bills the account the key belongs to. guilds.run keeps
no spend cap: a limit set on the provider's side is the only one. On
a provider marked **Cost shown**, each run records what it cost, from
the provider's own figure when it reports one and from the catalog's
rates otherwise, and the **Usage** tabs add it up. A local endpoint
and Kimi Code record no cost.

Every provider is called through its OpenAI-compatible Chat
Completions endpoint, by the orchestrator alone. The key is sent to
that provider and nowhere else.

## The welcome dialog

A box with no provider connected opens on a welcome dialog over the
app. It cannot be dismissed. An owner or admin walks through one
provider:

1. **Pick a provider.** A tile per provider, with a line on what it
   is for. Coding providers stand apart under **For coding agents
   only**.
2. **Connect.** Paste the key into **API key**. The field links to
   where the provider issues one. **Connect** sends it to the
   provider before saving it: a rejected key is not saved, and the
   dialog says why. The local endpoint takes a **Base URL** and an
   optional key.
3. **Choose models.** The provider's catalog, with a search over
   name and id. Tick at least one. These are the models every picker
   in the app offers, and nothing else. **Continue** saves the list.
4. **Pick a default.** One of the ticked models. New agents, Studio,
   and the Builder start on it. **Finish** saves it. **Skip for now**
   leaves none, and the create-agent form then waits for a choice. A
   coding provider ends at step 3.

The dialog closes. On a box with no guild the page says **No guilds
yet** and offers **Create a guild** or the Builder.
[Your first guild](first-guild.md) takes the first, so each screen is
met once.

A member who is not an owner or admin sees the dialog with a note to
ask one. The page opens on its own once a provider is connected.

More providers are connected afterwards under **Settings**, **Model
keys**, which holds the same controls.

## Three kinds of key

Three kinds of key reach the box. Only the first is a model key:

| Key | Who holds it | Where |
|---|---|---|
| Model key | The organisation, for its agents' runs | **Settings**, **Model keys** |
| Secret | The organisation, handed to the agents it names as an environment variable | **Secrets** ([Secrets and access](../concepts/secrets-and-access.md)) |
| Platform key | The box, for everyone on it: web search, group routing, the GitHub App, Google | **Admin**, **Platform keys** ([Configure](configure.md#platform-keys)); Sentry and the registry are `.env` settings |

An agent never sees a model key. Its sandbox gets secrets only.

A run is `provider + credentials + model`: the organisation's key for
the provider, and one of the models it chose for it.

## Settings, Model keys

The top of the page names the default model, or says that every
picker starts empty until one is marked.

Each provider has a card:

- its state: **Not connected**, or **Connected · key ends in** the
  key's last characters. The local endpoint shows its URL. A key is
  never shown again in full
- a key field, and a base URL field for the local endpoint, with
  **Connect**, or **Replace** once connected
- **Choose models**, which opens the provider's catalog
- **Remove**
- the chosen models, each with its id, what it takes (thinking,
  images), its context window, and its price per million tokens

Owners and admins connect, replace, remove, choose models, and set the
default. Every member reads the page.

### The key check

Connect and Replace send one request to the provider, `GET
{base URL}/models` with the key, and wait up to ten seconds. The key
is saved when that request succeeds. A `401` or `403` reads
`<Provider> rejected the key`; another failure gives its status or
the connection error. Nothing is written on failure, so a bad Replace
leaves the previous key in place.

### Choose models

**Choose models** opens the provider's catalog with a search over name
and id. Each row shows the model's id, whether it thinks and takes
images, its context window, and its price. Ticked rows are the
organisation's chosen models. **Save models** writes the list.

The catalog is [models.dev](https://models.dev), fetched once an hour
and kept as a snapshot for a box without network
([Configure](configure.md#model-catalog)). A model is listed when it
calls tools, is not deprecated, and takes and returns text. The local
endpoint's catalog is whatever its `/models` lists.

Unticking a model removes it from every picker. An agent already on it
keeps running; its picker shows the model under **Not offered**.

### The default

**Make default** on a chosen marketplace model names the
organisation's default. **Clear default** leaves none.

A new agent starts on the default; with none, the create form waits
for a choice. The Studio and Builder landings preselect it. **Investigate
in Studio** on an issue needs it, and asks for one on Model keys when
there is none. Any agent can be switched to another chosen model in
its **Settings**.

Unticking the default model, or removing its provider, clears the
default.

### Replace or remove a key

**Replace** saves a new key for a connected provider after the same
check. The chosen models and the default stay.

**Remove** drops the key, its chosen models, and the default when it
was among them, after a confirmation. Agents on that provider keep
their model and cannot run until a key is connected again.

A key does not rotate on its own. Rotate on the provider's side, then
Replace here.

## The local endpoint

**Local endpoint** is any server that speaks the OpenAI Chat
Completions API: Ollama, LM Studio, vLLM, or one of your own.

- **Base URL** is required and starts with `http://` or `https://`.
  It is the API root, `/v1` included where the server uses it.
  From the installed stack it is
  `http://host.docker.internal:<port>/v1`. `<port>` is the port a
  browser on the machine already uses.
- **API key** is optional. Leave it empty when the server asks for
  none; the check then calls `/models` without one.
- Its catalog is the endpoint's live `/models` list, read each time
  **Choose models** opens. Each model is offered with thinking on,
  temperature on, and images off.
- No cost is recorded.

The orchestrator calls that URL from inside its container.
`host.docker.internal` names the machine as the container sees it:
Compose maps it to the host's address on the Docker bridge. On a
default Docker install that address is `172.17.0.1`. A Base URL of
`http://127.0.0.1:<port>/v1` points at the container itself, and the
connection is refused.

The server has to accept connections on that bridge address. One
that listens only on the machine's loopback never sees the call: it
hangs, then times out.

**A program on the machine**, outside Docker (Ollama, LM Studio,
llama.cpp), listens on `127.0.0.1` unless told otherwise. Start it
on every interface, on the same port. Ollama:

```text
OLLAMA_HOST=0.0.0.0:11434
```

The Base URL is `http://host.docker.internal:11434/v1`. LM Studio
has to serve on the network, and llama.cpp takes `--host 0.0.0.0`.
Listening on `0.0.0.0` also makes the server reachable from other
machines on the local network.

**Another container** is reached through the port published on the
machine, which is the port in the Base URL. The port inside that
container is a different number. A publish limited to loopback is
enough for a browser and not for the orchestrator. Publish the same
host port on the bridge address as well. With the server listening
on `8080` inside its container and the browser using `8081`:

```yaml
ports:
  - "127.0.0.1:8081:8080"
  - "172.17.0.1:8081:8080"
```

The browser keeps `http://127.0.0.1:8081`. The Base URL is
`http://host.docker.internal:8081/v1`. The server stays off the
local network. On a machine whose bridge address is not
`172.17.0.1`, use the address `host.docker.internal` resolves to.
Publishing `8081:8080` alone also lets the orchestrator through:
Docker then binds every interface, so the port is open on the local
network too.

## Without a key

| Where | What shows |
|---|---|
| Create an agent, Studio, the Builder, and recipe apply, while no provider is connected | **Connect a model provider first**, with **Open Model keys**, in place of the model picker |
| Saving an agent on a provider that is not connected | `Connect a <Provider> key on Model keys first.` |
| An agent with **Coding** off, on a Kimi Code model | `Turn Coding on to use this model.` |
| A run on a provider whose key was removed | The run ends with `connect a <Provider> key on Model keys` |

Connecting the provider again, with any valid key, lets those agents
run as they were.

## Where keys live

A key is encrypted with AES-GCM under `SECRETS_MASTER_KEY` and stored
in the database, like every connector login and secret. Only its last
four characters are kept in the clear, for the card.

- `.env` never carries a model key. The `MODEL_CONTRACT_*` variables
  are for the development stack's contract tests, not the running
  stack ([Configure](configure.md#development)).
- A key never enters an agent's sandbox. An agent that needs an API
  key in its own scripts gets it as a
  [secret](../concepts/secrets-and-access.md).
- A backup of `STATE_ROOT` holds the keys and decrypts only with the
  `.env` it was made under ([Operate](operate.md#back-up)).

An edition built on core may resolve model credentials its own way,
with usage reporting and a policy
([Extension points](../architecture/extension-points.md)).

Next: [Your first guild](first-guild.md).
