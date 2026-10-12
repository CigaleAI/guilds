# Install

This page installs guilds.run on your machine. At the end, the app is
open in your browser.

guilds.run runs on one machine. It needs Docker and nothing else. No
cloud account, no email provider, no reverse proxy.

## What you need

- Docker, with the Compose plugin. Run `docker compose version` to
  check. It prints a version when Docker is ready.
- git and bash.
- Free disk space for the images and for agent files. The images
  include a browser and coding tools.

You do not need Node or pnpm. Those are for people who
[change the code](../contributing/development.md).

## Run three commands

```text
git clone https://github.com/CigaleAI/guilds.git && cd guilds
./setup.sh
docker compose up --detach --wait
```

The second command, `./setup.sh`, creates a file named `.env` and
builds the Docker images. The build takes several minutes the first
time. When it is done, it prints `Ready.`

Keep the `.env` file. It holds the key that encrypts every credential
the box stores. Nothing else has a copy.

The third command starts the app. It returns when the app is ready.

## Check it worked

Open `http://127.0.0.1:8080/` in your browser.

You should see a dialog titled **Welcome to guilds.run**. It asks for
a model provider. That is the next page.

You are already signed in. The box has one user, named `operator`,
and one organisation, named `Home`. Anyone who reaches this address
on this machine is that operator. To let other people in, read
[Remote access](remote-access.md) later.

If the page does not load, run `docker compose ps`. It shows which
service is not healthy. Then run `docker compose logs orchestrator`
to read why. [Operate](operate.md#when-it-fails) explains each
message.

Next: [Connect a model](model-keys.md).
