import { ArrowLeft, ExternalLink } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useConnectModelProvider,
  useOrgModels,
  useSetDefaultModel,
} from "../../api/queries/models";
import {
  hasConnectedProvider,
  type ModelProvider,
  type OrgModelProvider,
} from "../../api/types/models";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  RadioGroup,
  SkeletonRows,
  TextField,
  cn,
} from "@guildsrun/ui";
import { CatalogPicker } from "./ModelProviders";
import { ProviderLogo } from "./ProviderLogo";
import { PROVIDER_META } from "./models";

type Step = "pick" | "connect" | "models" | "default";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "connect", label: "Connect" },
  { id: "models", label: "Choose models" },
  { id: "default", label: "Pick a default" },
];

/**
 * The first thing an operator sees on a box with no model provider connected: a welcome that
 * walks them through one provider, its models, and the default. Nothing can run until a provider
 * is connected, so the dialog cannot be closed before that; it stays through the two steps after
 * so the pickers are not left empty. A member reads why the page waits.
 */
export function ModelSetupGate() {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const [gated, setGated] = useState(false);
  const [finished, setFinished] = useState(false);
  const [step, setStep] = useState<Step>("pick");
  const [providerId, setProviderId] = useState<ModelProvider | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const canManage = org.role === "owner" || org.role === "admin";
  const connected = hasConnectedProvider(models.data);
  // Once the gate has opened it stays through choosing models and a default, instead of closing
  // on the first key.
  if (connected === false && !gated) {
    setGated(true);
  }
  if (!gated || finished) {
    return null;
  }
  const provider = models.data?.providers.find((item) => item.id === providerId) ?? null;

  return (
    <Dialog open>
      <DialogContent
        size="lg"
        closeLabel={null}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {models.isPending ? (
          <>
            <DialogHeader title="Welcome to guilds.run" />
            <DialogBody>
              <SkeletonRows rows={3} label="Loading model keys" />
            </DialogBody>
          </>
        ) : models.isError || !models.data ? (
          <>
            <DialogHeader title="Welcome to guilds.run" />
            <DialogBody>
              <Banner tone="error" title="Couldn't load model keys" meta={models.error?.message} />
            </DialogBody>
          </>
        ) : !canManage ? (
          <>
            <DialogHeader
              title="Almost ready"
              description={`Agents run on ${org.name}'s own model keys, and none is connected yet.`}
            />
            <DialogBody>
              <p className="rounded-xl bg-paper p-4 text-sm text-fg-2">
                Ask an owner or admin of {org.name} to connect a model provider under Settings → Model
                keys. This page opens on its own once one is connected.
              </p>
            </DialogBody>
          </>
        ) : step === "pick" || !provider ? (
          <PickProvider
            providers={models.data.providers}
            onPick={(id) => {
              setProviderId(id);
              setTicked([]);
              setStep("connect");
            }}
          />
        ) : step === "connect" ? (
          <ConnectProvider
            provider={provider}
            onBack={() => setStep("pick")}
            onConnected={() => setStep("models")}
          />
        ) : step === "models" ? (
          <>
            <StepHeader provider={provider} step="models" title={`Choose the models ${provider.label} offers`} />
            <DialogBody>
              <p className="text-sm text-fg-2">
                Tick the models your agents may run on. You can change the list any time under
                Settings → Model keys.
              </p>
              <CatalogPicker
                provider={provider}
                chosen={ticked}
                saveLabel="Continue"
                requireOne
                onSaved={(saved) => {
                  setTicked(saved);
                  if (provider.kind === "marketplace") {
                    setStep("default");
                  } else {
                    setFinished(true);
                  }
                }}
              />
            </DialogBody>
          </>
        ) : (
          <PickDefault
            provider={provider}
            chosen={ticked}
            onFinished={() => setFinished(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type StepHeaderProps = { provider: OrgModelProvider; step: Step; title: string };

/** The three steps after picking a provider, with the current one marked. */
function StepHeader({ provider, step, title }: StepHeaderProps) {
  return (
    <DialogHeader
      title={
        <span className="flex items-center gap-3">
          <ProviderLogo provider={provider.id} size={36} />
          <span>{title}</span>
        </span>
      }
      description={
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {STEPS.map((item, index) => {
            const done = STEPS.findIndex((candidate) => candidate.id === step) > index;
            const current = item.id === step;
            return (
              <span
                key={item.id}
                className={cn("text-xs", current ? "font-semibold text-fg" : done ? "text-muted line-through" : "text-muted")}
              >
                {index + 1}. {item.label}
              </span>
            );
          })}
        </span>
      }
    />
  );
}

type PickProviderProps = {
  providers: OrgModelProvider[];
  onPick: (provider: ModelProvider) => void;
};

function PickProvider({ providers, onPick }: PickProviderProps) {
  const marketplace = providers.filter((item) => item.kind === "marketplace");
  const coding = providers.filter((item) => item.kind === "coding");
  const tile = (provider: OrgModelProvider) => (
    <button
      key={provider.id}
      type="button"
      onClick={() => onPick(provider.id)}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl bg-paper p-4 text-left",
        "hover:bg-paper-hi focus-visible:outline-none focus-visible:inset-ring-[1.5px] focus-visible:inset-ring-fg",
      )}
    >
      <ProviderLogo provider={provider.id} size={44} tone="well" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-md font-semibold">{provider.label}</span>
        <span className="text-xs text-muted">{PROVIDER_META[provider.id].blurb}</span>
      </span>
    </button>
  );
  return (
    <>
      <DialogHeader
        title="Welcome to guilds.run"
        description="Your agents run on your own model keys. Connect one provider to get going; you can add more later under Settings → Model keys."
      />
      <DialogBody className="gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="type-label text-muted">Pick a provider</h3>
          <div className="grid gap-3 sm:grid-cols-2">{marketplace.map(tile)}</div>
        </section>
        {coding.length ? (
          <section className="flex flex-col gap-2">
            <h3 className="type-label text-muted">For coding agents only</h3>
            <div className="grid gap-3 sm:grid-cols-2">{coding.map(tile)}</div>
          </section>
        ) : null}
      </DialogBody>
    </>
  );
}

type ConnectProviderProps = {
  provider: OrgModelProvider;
  onBack: () => void;
  onConnected: () => void;
};

function ConnectProvider({ provider, onBack, onConnected }: ConnectProviderProps) {
  const { org } = useIdentity();
  const connect = useConnectModelProvider(org.id);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.base_url ?? "");
  const local = provider.id === "local";
  const meta = PROVIDER_META[provider.id];
  const canSave = local ? Boolean(url.trim()) : Boolean(key.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    connect.mutate(
      {
        provider: provider.id,
        ...(key.trim() ? { api_key: key.trim() } : {}),
        ...(local ? { base_url: url.trim() } : {}),
        models: [],
      },
      { onSuccess: onConnected },
    );
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <StepHeader provider={provider} step="connect" title={`Connect ${provider.label}`} />
      <DialogBody className="gap-4">
        <p className="text-sm text-fg-2">
          {local
            ? "Point guilds.run at the server's OpenAI-compatible base URL. Add a key only if the server asks for one."
            : `Paste ${org.name}'s ${provider.label} API key. It is checked against ${provider.label}, then stored encrypted; only its last characters are ever shown.`}
        </p>
        {local ? (
          <TextField
            tone="paper"
            label="Base URL"
            placeholder={meta.urlPlaceholder}
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
          />
        ) : null}
        <TextField
          tone="paper"
          label={local ? "API key (optional)" : "API key"}
          type="password"
          autoComplete="off"
          autoFocus={!local}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          hint={
            meta.keyURL ? (
              <a href={meta.keyURL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                Get a key from {provider.label}
                <Icon icon={ExternalLink} size={14} />
              </a>
            ) : undefined
          }
        />
        {connect.isError ? (
          <Banner tone="error" title={`Couldn't connect ${provider.label}`}>
            {connect.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack}>
          <Icon icon={ArrowLeft} size={14} />
          Back
        </Button>
        <Button type="submit" variant="accent" disabled={!canSave || connect.isPending}>
          {connect.isPending ? "Checking the key…" : "Connect"}
        </Button>
      </DialogFooter>
    </form>
  );
}

type PickDefaultProps = {
  provider: OrgModelProvider;
  chosen: string[];
  onFinished: () => void;
};

function PickDefault({ provider, chosen, onFinished }: PickDefaultProps) {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const setDefault = useSetDefaultModel(org.id);
  const [choice, setChoice] = useState(chosen[0] ?? "");
  const options = chosen.map((id) => {
    const entry = models.data?.models.find((model) => model.id === id);
    return { value: id, label: entry?.label ?? id };
  });
  return (
    <>
      <StepHeader provider={provider} step="default" title="Pick a default model" />
      <DialogBody className="gap-4">
        <p className="text-sm text-fg-2">
          New agents, Studio and the Builder start on it. Any agent can be switched to another of the
          chosen models.
        </p>
        <RadioGroup value={choice} onValueChange={setChoice} options={options} />
        {setDefault.isError ? (
          <Banner tone="error" title="Couldn't set the default">
            {setDefault.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onFinished}>
          Skip for now
        </Button>
        <Button
          variant="accent"
          disabled={!choice || setDefault.isPending}
          onClick={() => setDefault.mutate(choice, { onSuccess: onFinished })}
        >
          Finish
        </Button>
      </DialogFooter>
    </>
  );
}
