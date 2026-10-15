# CORE is where this repository sits under the directory make runs in. An edition on top of core
# holds core in a subdirectory and includes this file from its own Makefile, after setting CORE,
# EDITION, the variables an edition names below, and SECRET_GOALS, the goals that start a box
# with real secrets. make then runs in the edition's root, where its .env, state and workspace
# are, and COMPOSE is the Compose command that reads that .env.
CORE ?= .
COMPOSE ?= docker compose
STATE_ROOT ?= $(abspath .state)

export CORE
export STATE_ROOT

.DEFAULT_GOAL := contract

# Development secrets. A goal in SECRET_GOALS gets none of them, not even exported empty:
# anything make exports wins over the value .env sets, so a box started with one of those goals
# reads its secrets from .env or the caller's environment.
ifeq ($(filter $(SECRET_GOALS),$(MAKECMDGOALS)),)
POSTGRES_PASSWORD ?= agent_platform
OPENSANDBOX_API_KEY ?= guilds-dev
SECRETS_MASTER_KEY ?= 0000000000000000000000000000000000000000000000000000000000000000
export POSTGRES_PASSWORD
export OPENSANDBOX_API_KEY
export SECRETS_MASTER_KEY
endif

# The development stack runs core alone, unless an edition names its own. COMPOSE_DEV is that
# stack, DEV_BASE_IMAGE the target that builds the image it starts from, WEB_PACKAGE the operator
# app `make dev` serves, and SEED_USER and SEED_ORG_SLUG who verify and soak act as.
EDITION ?= core
ifeq ($(EDITION),core)
COMPOSE_DEV := $(COMPOSE) -f $(CORE)/docker-compose.dev.yml
DEV_BASE_IMAGE :=
WEB_PACKAGE := @guildsrun/web
SEED_USER := user_operator
SEED_ORG_SLUG := home
endif
ifndef COMPOSE_DEV
$(error EDITION=$(EDITION) names no development stack: an edition sets COMPOSE_DEV)
endif
COMPOSE_ALL := $(COMPOSE) -f $(CORE)/docker-compose.yml $(EDITION_COMPOSE_FILES)

.PHONY: contract contract-opensandbox contract-model state opensandbox-image runtime-image core-image build up up-dev dev down reset migrate verify check soak compat-verify

contract: contract-opensandbox contract-model

contract-opensandbox:
	RUN_OPENSANDBOX_CONTRACT=1 pnpm --filter @guildsrun/orchestrator exec node --import tsx --test test/contract/opensandbox.test.ts test/contract/coding.test.ts

contract-model:
	@if [ ! -f .env ]; then echo "MODEL_CONTRACT_MODEL and MODEL_CONTRACT_API_KEY are required in .env"; exit 1; fi
	@set -a && . ./.env && set +a && \
		if [ -z "$$MODEL_CONTRACT_MODEL" ] || [ -z "$$MODEL_CONTRACT_API_KEY" ]; then echo "MODEL_CONTRACT_MODEL and MODEL_CONTRACT_API_KEY are required in .env"; exit 1; fi && \
		RUN_MODEL_CONTRACT=1 \
			pnpm --filter @guildsrun/orchestrator exec node --import tsx --test test/contract/model.test.ts

state:
	mkdir -p "$(STATE_ROOT)/notes" "$(STATE_ROOT)/workspaces" "$(STATE_ROOT)/attachments" "$(STATE_ROOT)/connectors" "$(STATE_ROOT)/postgres" "$(STATE_ROOT)/opensandbox"

opensandbox-image:
	$(CORE)/scripts/images.sh opensandbox

runtime-image:
	$(CORE)/scripts/images.sh runtime

core-image:
	docker build --tag guilds-orchestrator:local --file $(CORE)/apps/orchestrator/Dockerfile $(CORE)

build: state opensandbox-image runtime-image $(DEV_BASE_IMAGE)
	$(COMPOSE_DEV) build

up: up-dev

# Live reload: the stack in Docker, the orchestrator restarting on source changes, and the web
# app's Vite server with hot reload at http://127.0.0.1:5173/ in the foreground.
dev: up-dev
	pnpm --filter $(WEB_PACKAGE) dev

up-dev: state opensandbox-image runtime-image $(DEV_BASE_IMAGE)
	$(COMPOSE_DEV) up --build --detach --wait --remove-orphans

down:
	$(COMPOSE_ALL) down --remove-orphans

# Clean-box reset of local state.
reset:
	@if [ "$(STATE_ROOT)" = "/srv" ] || [ "$(STATE_ROOT)" = "/srv/" ]; then echo "refusing make reset on production STATE_ROOT=/srv"; exit 1; fi
	$(MAKE) down
	rm -rf "$(STATE_ROOT)/postgres" "$(STATE_ROOT)/opensandbox" "$(STATE_ROOT)/workspaces" "$(STATE_ROOT)/notes" "$(STATE_ROOT)/attachments" "$(STATE_ROOT)/connectors"
	$(MAKE) up

# Applies new migrations to the development database and keeps its data: each recorded migration
# gets its committed stamp, so none is skipped, then the orchestrator restarts on the result.
migrate:
	$(COMPOSE_DEV) run --rm --no-deps orchestrator node_modules/.bin/tsx src/cli/migrate.ts
	$(COMPOSE_DEV) restart orchestrator
	$(COMPOSE_DEV) up --detach --wait --no-deps orchestrator

verify:
	curl -fsS http://127.0.0.1:8080/health
	curl -fsS -H "X-Guilds-User: $(SEED_USER)" http://127.0.0.1:8080/api/guilds
	curl -fsS -H "Accept: text/html" http://127.0.0.1:8080/ | grep -q 'id="root"'
	pnpm -r typecheck
	pnpm -r lint
	pnpm --filter @guildsrun/orchestrator test
	$(foreach package,$(EDITION_TEST_PACKAGES),pnpm --filter $(package) test &&) true
	pnpm --filter @guildsrun/orchestrator compat:verify

# What CI's verify workflow runs, against a throwaway Postgres. The pre-push hook runs it on the
# pushed commits; COMMIT=<rev> checks one commit in a clean checkout.
check:
	$(CORE)/scripts/check.sh $(COMMIT)

soak:
	curl -fsS http://127.0.0.1:8080/health
	curl -fsS -H "X-Guilds-User: $(SEED_USER)" http://127.0.0.1:8080/api/guilds
	curl -sS http://127.0.0.1:8080/api/mcp/oauth/callback | grep -q "Authorization Cancelled"
	guild_id=$$(curl -fsS -H "X-Guilds-User: $(SEED_USER)" -H "Content-Type: application/json" \
		-d '{"name":"soak-idle"}' http://127.0.0.1:8080/api/guilds | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id))'); \
		code=$$(curl -fsS -o /dev/null -w '%{http_code}' -X DELETE -H "X-Guilds-User: $(SEED_USER)" \
			http://127.0.0.1:8080/api/guilds/$$guild_id); \
		test "$$code" = "204"
	$(COMPOSE_DEV) restart orchestrator
	$(COMPOSE_DEV) up --detach --wait --no-deps orchestrator
	curl -fsS http://127.0.0.1:8080/health
	$(COMPOSE_DEV) exec -T postgres psql -U agent_platform -d agent_platform -v ON_ERROR_STOP=1 \
		-c "SELECT hash FROM __drizzle_migrations;" \
		-c "SELECT id, email FROM users WHERE id = '$(SEED_USER)';" \
		-c "SELECT slug FROM orgs WHERE slug = '$(SEED_ORG_SLUG)';" \
		-c "SELECT COUNT(*) AS platform_native_bindings FROM bindings WHERE scope = 'platform' AND catalog_kind = 'native_tool';" \
		-c "SELECT COUNT(*) AS stuck_active_runs FROM runs WHERE status = 'active';"

compat-verify:
	pnpm --filter @guildsrun/orchestrator compat:verify
