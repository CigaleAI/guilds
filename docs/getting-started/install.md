# Install

This page installs guilds.run on your machine. At the end, the app is
open in your browser.

guilds.run runs on one machine. Docker is all it needs.

## What you need

- Docker, with the Compose plugin. Run `docker compose version` to
  check. It prints a version when Docker is ready.
- git and bash.
- Free disk space for the images and for agent files. The images
  include a browser and coding tools.

Node and pnpm are for people who
[change the code](../contributing/development.md) only.

## Run three commands

```text
git clone https://github.com/CigaleAI/guilds.git && cd guilds
./setup.sh
docker compose up --detach --wait
```

The second command, `./setup.sh`, creates a file named `.env`. It
then builds two Docker images: the sandbox server, and the image
your agents run in. The build takes several minutes the first time.
When it is done, it prints `Ready.`

Keep the `.env` file. It holds the key that encrypts every credential
the box stores. Nothing else has a copy.

The third command builds the app's own image the first time, then
starts the app. It returns when the app is ready.

## Check it worked

Open `http://127.0.0.1:8080/` in your browser.

You should see a dialog titled **Welcome to guilds.run**. It asks for
a model provider. That is the next page.

You are already signed in. The box has one user, named `operator`,
and one organisation, named `Home`. Anyone who reaches this address
on this host is that operator. To let other people in, read
[Remote access](../operations/remote-access.md) later.

If the page does not load, run `docker compose ps`. It shows which
service is not healthy. Then run `docker compose logs orchestrator`
to read why. [Maintain](../operations/maintain.md#when-it-fails)
explains each message.

Next: [Connect a model](model-keys.md).
