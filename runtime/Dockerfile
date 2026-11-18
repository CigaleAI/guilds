FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ripgrep \
        ca-certificates \
        tzdata \
        locales \
        chromium \
        chromium-l10n \
        tigervnc-standalone-server \
        novnc \
        websockify \
        x11-utils \
        matchbox-window-manager \
        fonts-liberation \
        fonts-noto-core \
        fonts-noto-color-emoji \
        libvulkan1 \
        build-essential \
        pkg-config \
        fd-find \
        jq \
        unzip \
        patch \
        xz-utils \
        openssh-client \
        procps \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && printf 'en_US.UTF-8 UTF-8\n' > /etc/locale.gen \
    && locale-gen \
    && mkdir -p \
        /etc/chromium/policies/managed \
        /etc/chromium-browser/policies/managed \
        /etc/opt/chrome/policies/managed \
    && printf '%s\n' '{"CommandLineFlagSecurityWarningsEnabled": false, "HomepageLocation": "about:blank", "HomepageIsNewTabPage": false, "NewTabPageLocation": "about:blank", "RestoreOnStartup": 4, "RestoreOnStartupURLs": ["about:blank"]}' \
        | tee /etc/chromium/policies/managed/guilds.json \
        | tee /etc/chromium-browser/policies/managed/guilds.json \
        > /etc/opt/chrome/policies/managed/guilds.json \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir playwright==1.52.0

# Google Chrome on amd64 by default. Chrome may not be redistributed, so an image that is
# published is built with --build-arg BROWSER=chromium and runs Debian's Chromium everywhere.
ARG BROWSER=chrome
COPY install-chrome.py /tmp/install-chrome.py
RUN BROWSER="$BROWSER" python3 /tmp/install-chrome.py && rm /tmp/install-chrome.py

# ttyd serves the CLI tab: a bash session over WebSocket, started on demand by
# agent-cli-start. Debian does not package it, so the release binary is pinned.
ARG TTYD_VERSION=1.7.7
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) asset=ttyd.x86_64; sum=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;; \
        arm64) asset=ttyd.aarch64; sum=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;; \
        *) echo "unsupported architecture for ttyd" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}"; \
    echo "${sum}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 755 /usr/local/bin/ttyd

# gost relays each browser slot's DevTools port from every interface to Chrome's loopback
# port, setting each request's Host to Chrome's, started by agent-browser-start. Release
# tarball, pinned and checksum-verified.
ARG GOST_VERSION=3.3.0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) asset=linux_amd64; sum=676fb7f78d267b6ae73df719c0c7f2b565dde7147da935cfafbc1e1da558b6d5 ;; \
        arm64) asset=linux_arm64; sum=d03699e3f385d4ff5dad68046712adfcc7515325a064d2ab046e0bece30f8f8f ;; \
        *) echo "unsupported architecture for gost" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gost.tar.gz "https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_${asset}.tar.gz"; \
    echo "${sum}  /tmp/gost.tar.gz" | sha256sum -c -; \
    mkdir /tmp/gost; \
    tar -xzf /tmp/gost.tar.gz -C /tmp/gost --no-same-owner gost; \
    install -m 755 /tmp/gost/gost /usr/local/bin/gost; \
    rm -rf /tmp/gost.tar.gz /tmp/gost

# Node.js for JavaScript and TypeScript projects and for the coding harnesses. Release
# tarball, pinned and checksum-verified per architecture.
ARG NODE_VERSION=24.21.0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) asset=linux-x64; sum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;; \
        arm64) asset=linux-arm64; sum=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;; \
        *) echo "unsupported architecture for node" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${asset}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
        --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    node --version

# GitHub CLI for the agent's own commands; the box gives it no login, so pull requests open with
# the repository host's connector tools. Release tarball, pinned and checksum-verified.
ARG GH_VERSION=2.102.0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) asset=linux_amd64; sum=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
        arm64) asset=linux_arm64; sum=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
        *) echo "unsupported architecture for gh" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${asset}.tar.gz"; \
    echo "${sum}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 755 "/tmp/gh_${GH_VERSION}_${asset}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_${asset}"

# mise installs other language toolchains; the agent runs it, and with HOME in the
# workspace what it installs persists. Release binary, pinned and checksum-verified.
ARG MISE_VERSION=2026.9.18
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) asset=linux-x64; sum=d24fe0bf7e613824ad99f7b8dac3f2b381a37b9f75f84dd250855217095a8de4 ;; \
        arm64) asset=linux-arm64; sum=2142433ae70decffc5fa24bd160e47931e33f55eb031d128beb97cbae634d168 ;; \
        *) echo "unsupported architecture for mise" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${asset}"; \
    echo "${sum}  /usr/local/bin/mise" | sha256sum -c -; \
    chmod 755 /usr/local/bin/mise

# Coding harnesses, each run headless by guilds-harness on the user's own subscription. Codex is
# open source and always installed. Claude Code, the Cursor CLI, and the Antigravity CLI are
# proprietary: they are installed when HARNESSES names them, as Chrome is under BROWSER, and an
# image that is published is built with HARNESSES empty. The Cursor and Antigravity CLIs have no
# npm package: their release tarballs are pinned and checksum-verified per architecture. The
# Antigravity binary is started through the agy wrapper, which holds it at the pinned version.
ARG HARNESSES="claude-code cursor antigravity"
ARG CODEX_VERSION=0.170.0
ARG CLAUDE_CODE_VERSION=2.1.327
ARG CURSOR_VERSION=2026.11.17-f532c45
ARG ANTIGRAVITY_VERSION=1.5.11-6132547114106880
COPY agy /usr/local/share/guilds/agy
RUN set -eu; \
    for harness in $HARNESSES; do \
        case "$harness" in claude-code|cursor|antigravity) ;; *) echo "unknown harness $harness" >&2; exit 1 ;; esac; \
    done; \
    mkdir -p /usr/local/share/guilds; \
    npm install --global --no-fund --no-audit "@openai/codex@${CODEX_VERSION}"; \
    codex --version; \
    echo codex > /usr/local/share/guilds/harnesses; \
    case " $HARNESSES " in *" claude-code "*) \
        npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
        claude --version; \
        echo claude-code >> /usr/local/share/guilds/harnesses ;; \
    esac; \
    case " $HARNESSES " in *" cursor "*) \
        case "$(dpkg --print-architecture)" in \
            amd64) asset=x64; sum=189ed41d8963cd22dcdafbbd62f072cc55ac08374c922dbd04aee525f4018ab6 ;; \
            arm64) asset=arm64; sum=dff929e5e5ace2ced880290095df5938545267d73fd1d84be669be75dbdc1558 ;; \
            *) echo "unsupported architecture for the Cursor CLI" >&2; exit 1 ;; \
        esac; \
        curl -fsSL -o /tmp/cursor.tar.gz "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${asset}/agent-cli-package.tar.gz"; \
        echo "${sum}  /tmp/cursor.tar.gz" | sha256sum -c -; \
        mkdir -p "/opt/cursor-agent/${CURSOR_VERSION}"; \
        tar -xzf /tmp/cursor.tar.gz -C "/opt/cursor-agent/${CURSOR_VERSION}" --strip-components=1 --no-same-owner; \
        rm /tmp/cursor.tar.gz; \
        ln -s "/opt/cursor-agent/${CURSOR_VERSION}/cursor-agent" /usr/local/bin/agent; \
        agent --version; \
        echo cursor >> /usr/local/share/guilds/harnesses ;; \
    esac; \
    case " $HARNESSES " in *" antigravity "*) \
        case "$(dpkg --print-architecture)" in \
            amd64) asset=linux-x64/cli_linux_x64; sum=dad3c015e8964fcdc1639b13b7152f4cb84cb1bde385707e2bcdf095d6f1831f4f6521199aec499cc052f9e99906b7fdbc52c273df064d5cb7c84b068ba3ce50 ;; \
            arm64) asset=linux-arm/cli_linux_arm64; sum=5f703c88e01851061c87c07b1a4ca54c1f5a6826ffada9fb005974a099e9a552ddb1f9ba2fe1194e2829803482c86084babf8cf91530a528bc7f659613600585 ;; \
            *) echo "unsupported architecture for the Antigravity CLI" >&2; exit 1 ;; \
        esac; \
        curl -fsSL -o /tmp/antigravity.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${ANTIGRAVITY_VERSION}/${asset}.tar.gz"; \
        echo "${sum}  /tmp/antigravity.tar.gz" | sha512sum -c -; \
        mkdir -p "/opt/antigravity/${ANTIGRAVITY_VERSION}"; \
        tar -xzf /tmp/antigravity.tar.gz -C "/opt/antigravity/${ANTIGRAVITY_VERSION}" --no-same-owner antigravity; \
        rm /tmp/antigravity.tar.gz; \
        ln -s "/opt/antigravity/${ANTIGRAVITY_VERSION}/antigravity" /opt/antigravity/antigravity; \
        install -m 755 /usr/local/share/guilds/agy /usr/local/bin/agy; \
        HOME=/tmp/antigravity-home agy --version; \
        rm -rf /tmp/antigravity-home; \
        echo antigravity >> /usr/local/share/guilds/harnesses ;; \
    esac; \
    rm /usr/local/share/guilds/agy; \
    npm cache clean --force
# Claude Code reads its managed settings here; no user or project file overrides them.
COPY claude-code-managed-settings.json /etc/claude-code/managed-settings.json

COPY agent-browser-start /usr/local/bin/agent-browser-start
COPY agent-cli-start /usr/local/bin/agent-cli-start
COPY agent-stop /usr/local/bin/agent-stop
COPY agent-lib.sh /usr/local/lib/guilds/agent-lib.sh
COPY guilds-browser /usr/local/bin/guilds-browser
COPY guilds-script-run /usr/local/bin/guilds-script-run
COPY guilds-locale /usr/local/bin/guilds-locale
COPY guilds-code /usr/local/bin/guilds-code
COPY guilds-harness /usr/local/bin/guilds-harness
COPY guilds-git-credential /usr/local/bin/guilds-git-credential
# The platform's git hooks, each hook name a link to guilds-hook; a harness turn's environment
# points core.hooksPath at them.
COPY git-hooks /usr/local/share/guilds/git-hooks
# git asks the credential helper for every HTTPS host (`https://` names them all) with the
# repository path, so each guild repository gets its own token.
RUN git config --system credential.https://.helper /usr/local/bin/guilds-git-credential \
    && git config --system credential.https://.useHttpPath true \
    && git config --system init.defaultBranch main
# The same helper from the environment, which git reads after every configuration file: the
# agent's own git configuration cannot replace it. An empty `helper` drops every helper set
# before it for an HTTPS host, as `gh auth setup-git` writes into the agent's home; this one is
# set after it.
ENV GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0=credential.https://.helper \
    GIT_CONFIG_VALUE_0="" \
    GIT_CONFIG_KEY_1=credential.https://.helper \
    GIT_CONFIG_VALUE_1=/usr/local/bin/guilds-git-credential \
    GIT_CONFIG_KEY_2=credential.https://.useHttpPath \
    GIT_CONFIG_VALUE_2=true
RUN chmod 755 /usr/local/bin/agent-browser-start /usr/local/bin/agent-cli-start /usr/local/bin/agent-stop \
        /usr/local/bin/guilds-browser /usr/local/bin/guilds-script-run /usr/local/bin/guilds-locale \
        /usr/local/bin/guilds-code /usr/local/bin/guilds-harness /usr/local/bin/guilds-git-credential \
        /usr/local/share/guilds/git-hooks/guilds-hook \
    && chmod 644 /usr/local/lib/guilds/agent-lib.sh /etc/claude-code/managed-settings.json \
    && mkdir -p /tmp/.X11-unix /run/guilds/requests \
    && chmod 1777 /tmp/.X11-unix \
    && chmod 700 /run/guilds

ENV LANG=en_US.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /home
