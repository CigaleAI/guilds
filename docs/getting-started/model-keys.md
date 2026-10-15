# Connect a model

Agents need a model to run. You give guilds.run an API key from a
model provider. This page shows how.

The welcome dialog does it in four steps. You paste a key, you tick
the models your agents may use, and you pick one as the default.

## Pick a provider

You need one key from one provider. Any provider in this table works
for the rest of the tutorial.

| Provider | What you get | Where to get a key |
|---|---|---|
| OpenAI | GPT models | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| OpenRouter | Hundreds of models behind one key, Claude and Gemini included | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| xAI | Grok models | [console.x.ai](https://console.x.ai/) |
| DeepInfra | Open-weight models at a low price | [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys) |
| Local endpoint | A model server you run yourself, such as Ollama, LM Studio, or vLLM | No key needed |

Your key goes to that provider and nowhere else.

The provider bills you for what your agents use. guilds.run sets no
spending limit. Set one on the provider's side if you want one.

The dialog also lists **Kimi Code** under **For coding agents only**.
Skip it for now. It serves coding agents only, and it cannot be the
default.
[Model keys](../concepts/model-keys.md#providers)
explains it.

### If you run a local model server

Pick **Local endpoint**. Type the server's address into **Base URL**.
Include `/v1` when your server uses it. Leave **API key** empty when
your server needs none.

guilds.run runs inside Docker. So `127.0.0.1` means the container,
not your machine. On Docker Desktop, use
`http://host.docker.internal:<port>/v1`. On Linux, use your
machine's address on the Docker network, and make the server listen
on it. [Model keys](../concepts/model-keys.md#the-local-endpoint)
has the details.

## The welcome dialog

1. **Pick a provider.** Click the provider's tile.
2. **Connect.** Paste your key into **API key**. Click **Connect**.
   guilds.run checks the key with the provider before it saves it. A
   bad key is not saved, and the dialog says why.
3. **Choose models.** Tick at least one model. These are the models
   your agents can use. Click **Continue**.
4. **Pick a default.** Pick one of the models you ticked. New agents
   start on it. Click **Finish**.

The dialog closes. You should see a page that says **No guilds yet**.

## Later

You can add more providers, replace a key, or change the default
under **Settings**, **Model keys**.
[Model keys](../concepts/model-keys.md) describes that page.

Next: [Your first guild](first-guild.md).
