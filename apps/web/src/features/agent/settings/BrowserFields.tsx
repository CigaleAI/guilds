import { Link, useLocation } from "@tanstack/react-router";
import { useInstance } from "../../../api/queries/admin";
import type { InstanceIntegration, OrgModels } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { Select, Tag, Toggle } from "@guildsrun/ui";
import { missingFieldsPhrase, setupSearch, toolIntegrationGap } from "../../instance/instance";
import { modelOptions, preselectedModel } from "../../models/models";
import type { ConfigErrors, ConfigForm } from "./configForm";

/** Chrome language tags the settings picker offers, US English first. */
export const browserLanguageOptions = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "ar", label: "Arabic" },
  { value: "bg", label: "Bulgarian" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "el", label: "Greek" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "id", label: "Indonesian" },
  { value: "it-IT", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "ms", label: "Malay" },
  { value: "nb", label: "Norwegian" },
  { value: "pl", label: "Polish" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es-ES", label: "Spanish" },
  { value: "es-419", label: "Spanish (Latin America)" },
  { value: "sv", label: "Swedish" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "vi", label: "Vietnamese" },
] as const;

function languageOptions(current: string) {
  if (browserLanguageOptions.some((item) => item.value === current)) {
    return browserLanguageOptions;
  }
  return [{ value: current, label: current }, ...browserLanguageOptions];
}

/**
 * The form with the browser switched: turning it off also turns off the agent-optimized browser
 * and clears its model.
 */
export function withBrowser(form: ConfigForm, browser: boolean): ConfigForm {
  return browser
    ? { ...form, browser }
    : { ...form, browser, browser_optimized: false, browser_model: "" };
}

/**
 * The form with the agent-optimized browser switched. Turning it on keeps a model already picked,
 * else starts on the organisation's default when it is a marketplace model the organisation's key
 * runs, else on the first such model, else on none. Turning it off clears the model.
 */
export function withBrowserOptimized(
  form: ConfigForm,
  on: boolean,
  models: OrgModels | undefined,
): ConfigForm {
  if (!on) return { ...form, browser_optimized: false, browser_model: "" };
  const marketplace = { marketplaceOnly: true };
  const model =
    form.browser_model ||
    preselectedModel(models, marketplace) ||
    (modelOptions(models, marketplace)[0]?.options[0]?.value ?? "");
  return { ...form, browser_optimized: true, browser_model: model };
}

type BrowserFieldProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
};

/** A browser field that picks among, or defaults to, the organisation's models. */
type BrowserModelsProps = BrowserFieldProps & { models: OrgModels | undefined };

type BrowserModelFieldProps = BrowserModelsProps & { error: string | undefined };

type BrowserFieldsProps = BrowserModelsProps & { errors: ConfigErrors };

type PlatformKeyNoteProps = { integration: InstanceIntegration };

/** Chrome's language while the browser is on. */
function BrowserLanguageField({ form, onChange }: BrowserFieldProps) {
  return (
    <Select
      tone="surface"
      label="Browser language"
      hint="Chrome's interface language and the language sites see. Changing it restarts the browser."
      value={form.browser_language}
      onValueChange={(value) => onChange({ ...form, browser_language: value })}
      options={languageOptions(form.browser_language)}
    />
  );
}

/**
 * What a platform key still lacks on this server, in the words the Tools tab uses; a platform
 * admin gets the link to it under Admin → Platform keys, anyone else is told who sets it up. A key
 * the server's environment holds has no link: it is not entered in Admin.
 */
function PlatformKeyNote({ integration }: PlatformKeyNoteProps) {
  const { user } = useIdentity();
  const location = useLocation();
  const missing = missingFieldsPhrase(integration);
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-2">
      <Tag tone="ochre" font="sans">
        Not set up
      </Tag>
      {integration.label} is not set up on this server{missing ? `: ${missing} missing` : ""}.
      {integration.source !== "store" ? null : user.platform_admin ? (
        <Link to="/admin" search={setupSearch(integration.id, location.href)} className="underline">
          Set up
        </Link>
      ) : (
        "Ask a platform admin to set it up."
      )}
    </p>
  );
}

/**
 * The agent-optimized browser's switch. While the platform key that offers `browse` is not on, it
 * cannot be turned on and says what is missing; an agent already on it can still turn it off.
 */
function OptimizedBrowserField({ form, onChange, models }: BrowserModelsProps) {
  const instance = useInstance();
  const gap = toolIntegrationGap(instance.data, "browse");
  return (
    <div className="flex flex-col gap-2">
      <Toggle
        label="Agent-optimized browser"
        description="Delegates whole web tasks to the browse tool, with page citations. Needs a System One platform key."
        checked={form.browser_optimized}
        disabled={gap !== null && !form.browser_optimized}
        onCheckedChange={(on) => onChange(withBrowserOptimized(form, on, models))}
      />
      {gap ? <PlatformKeyNote integration={gap} /> : null}
    </div>
  );
}

/** The marketplace model the agent-optimized browser plans and reads pages with. */
function BrowserModelField({ form, onChange, models, error }: BrowserModelFieldProps) {
  return (
    <Select
      tone="surface"
      label="Browser model"
      placeholder="Choose a model"
      hint="The model the browse tool plans and reads pages with, on the organisation's key."
      value={form.browser_model}
      onValueChange={(value) => onChange({ ...form, browser_model: value })}
      options={modelOptions(models, { current: form.browser_model, marketplaceOnly: true })}
      {...(error ? { error } : {})}
    />
  );
}

/**
 * The browser's settings while it is on: Chrome's language, the agent-optimized browser, and,
 * with that on, the model it runs.
 */
export function BrowserFields({ form, onChange, models, errors }: BrowserFieldsProps) {
  return (
    <>
      <BrowserLanguageField form={form} onChange={onChange} />
      <OptimizedBrowserField form={form} onChange={onChange} models={models} />
      {form.browser_optimized ? (
        <BrowserModelField
          form={form}
          onChange={onChange}
          models={models}
          error={errors.browser_model}
        />
      ) : null}
    </>
  );
}
