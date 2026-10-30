import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectorFacts, LookupOption, McpServerAccess } from "../../api/types/access";
import { Icon, SearchField, Select, TextField } from "@guildsrun/ui";
import { isPlainObject } from "./toolArgs";

const searchDelayMs = 300;

/** A connector's `settings_schema`: the JSON Schema of what a login stores beside its credentials. */
type SettingsSchema = NonNullable<ConnectorFacts["settings_schema"]>;

/** A login's settings, the document its connector's `settings_schema` describes. */
export type SettingsValue = McpServerAccess["settings"];

/** Finds values for a property marked `x-lookup`; throws with the reason when it can't search. */
export type SettingsSearch = (property: string, query: string) => Promise<LookupOption[]>;

type SettingsFormProps = {
  schema: SettingsSchema;
  value: SettingsValue;
  /** Omit for an inherited login's settings, which this scope can only read. */
  onChange?: (next: SettingsValue) => void;
  search: SettingsSearch;
  disabled?: boolean;
};

/** A JSON value's fields: an object's own, none for any other value. */
function record(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** What a stored value shows as: an object's name or symbol, else the value itself. */
function itemLabel(item: unknown): string {
  const row = record(item);
  if (typeof row.name === "string" && row.name) {
    return typeof row.symbol === "string" && row.symbol ? `${row.symbol} · ${row.name}` : row.name;
  }
  if (typeof row.id === "string") return row.id;
  return typeof item === "string" ? item : JSON.stringify(item);
}

function itemKey(item: unknown): string {
  const row = record(item);
  return typeof row.id === "string"
    ? row.id
    : typeof item === "string"
      ? item
      : JSON.stringify(item);
}

/** Every property of a connector's settings, each as the input its schema calls for. */
export function SettingsForm({ schema, value, onChange, search, disabled }: SettingsFormProps) {
  const properties = Object.entries(record(schema.properties));
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return (
    <div className="flex flex-col gap-4">
      {properties.map(([name, raw]) => (
        <SettingInput
          key={name}
          name={name}
          property={record(raw)}
          required={required.has(name)}
          value={value[name]}
          disabled={Boolean(disabled) || !onChange}
          search={search}
          onChange={onChange ? (next) => onChange({ ...value, [name]: next }) : undefined}
        />
      ))}
    </div>
  );
}

type SettingInputProps = {
  name: string;
  /** The property's JSON Schema. */
  property: Record<string, unknown>;
  required: boolean;
  /** What the login stores for the property. */
  value: unknown;
  disabled: boolean;
  search: SettingsSearch;
  /** Undefined for a setting this scope can only read. */
  onChange: ((next: unknown) => void) | undefined;
};

/** One setting as the input its schema calls for: a lookup, a choice, yes or no, or text. */
function SettingInput({
  name,
  property,
  required,
  value,
  disabled,
  search,
  onChange,
}: SettingInputProps) {
  const label = `${typeof property.title === "string" ? property.title : name}${required ? "" : " (optional)"}`;
  const hint = typeof property.description === "string" ? property.description : "";
  if (property["x-lookup"] === true) {
    return (
      <LookupSetting
        property={property}
        label={label}
        hint={hint}
        disabled={disabled}
        value={value}
        search={(query: string) => search(name, query)}
        onChange={onChange}
      />
    );
  }
  if (Array.isArray(property.enum)) {
    return (
      <Select
        tone="surface"
        label={label}
        disabled={disabled}
        value={String(value ?? "")}
        onValueChange={(next) => onChange?.(next)}
        options={property.enum.map((option) => ({
          value: String(option),
          label: String(option),
        }))}
      />
    );
  }
  if (property.type === "boolean") {
    return (
      <Select
        tone="surface"
        label={label}
        disabled={disabled}
        value={value === true ? "true" : "false"}
        onValueChange={(next) => onChange?.(next === "true")}
        options={[
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ]}
      />
    );
  }
  return (
    <TextSetting
      property={property}
      label={label}
      hint={hint}
      disabled={disabled}
      value={value}
      onChange={onChange}
    />
  );
}

type LookupSettingProps = {
  property: Record<string, unknown>;
  label: string;
  hint: string;
  disabled: boolean;
  value: unknown;
  search: (query: string) => Promise<LookupOption[]>;
  onChange: ((next: unknown) => void) | undefined;
};

/** A setting marked `x-lookup`: a list of picks when its schema holds an array, one pick otherwise. */
function LookupSetting({
  property,
  label,
  hint,
  disabled,
  value,
  search,
  onChange,
}: LookupSettingProps) {
  const field = { label, hint, disabled, search };
  if (property.type === "array") {
    return (
      <LookupList
        {...field}
        items={Array.isArray(value) ? value : []}
        max={typeof property.maxItems === "number" ? property.maxItems : undefined}
        {...(onChange ? { onChange } : {})}
      />
    );
  }
  return <LookupOne {...field} current={value} {...(onChange ? { onChange } : {})} />;
}

type TextSettingProps = {
  property: Record<string, unknown>;
  label: string;
  hint: string;
  disabled: boolean;
  value: unknown;
  onChange: ((next: unknown) => void) | undefined;
};

/** A setting typed in: a number for a numeric schema, cleared to unset when emptied; text otherwise. */
function TextSetting({ property, label, hint, disabled, value, onChange }: TextSettingProps) {
  const numeric = property.type === "number" || property.type === "integer";
  return (
    <TextField
      tone="surface"
      label={label}
      {...(hint ? { hint } : {})}
      disabled={disabled}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => {
        const text = event.currentTarget.value;
        onChange?.(numeric ? (text === "" ? undefined : Number(text)) : text);
      }}
    />
  );
}

/** A search box over a property's lookup, debounced; `onPick` takes the chosen option. */
function useLookup(search: (query: string) => Promise<LookupOption[]>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    const mine = ++latest.current;
    if (!text) return;
    const timer = setTimeout(() => {
      search(text).then(
        (found) => {
          if (mine !== latest.current) return;
          setError(null);
          setResults(found);
        },
        (reason: Error) => {
          if (mine !== latest.current) return;
          setResults(null);
          setError(reason.message);
        },
      );
    }, searchDelayMs);
    return () => clearTimeout(timer);
  }, [query, search]);

  const reset = () => {
    setQuery("");
    setResults(null);
  };
  return { query, setQuery, results, setResults, error, reset };
}

type LookupFieldProps = {
  label: string;
  hint: string;
  disabled: boolean;
  search: (query: string) => Promise<LookupOption[]>;
};

type ResultsProps = {
  options: LookupOption[];
  onPick: (option: LookupOption) => void;
};

function Results({ options, onPick }: ResultsProps) {
  return (
    <ul className="flex max-h-56 flex-col overflow-y-auto rounded-lg bg-surface p-1">
      {options.length ? (
        options.map((option) => (
          <li key={itemKey(option.value)}>
            <button
              type="button"
              onClick={() => onPick(option)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-paper-hi"
            >
              {option.image ? (
                <img src={option.image} alt="" width={16} height={16} className="size-4" />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.detail ? (
                <span className="font-mono text-xs text-muted">{option.detail}</span>
              ) : null}
            </button>
          </li>
        ))
      ) : (
        <li className="px-2.5 py-1.5 text-sm text-muted">Nothing found.</li>
      )}
    </ul>
  );
}

type HeadingProps = { label: string; hint: string };

function Heading({ label, hint }: HeadingProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold">{label}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

type LookupListProps = LookupFieldProps & {
  items: unknown[];
  max: number | undefined;
  onChange?: (next: unknown[]) => void;
};

/** A list setting filled from a search: chips for what is stored, a search box to add more. */
function LookupList({ label, hint, disabled, search, items, max, onChange }: LookupListProps) {
  const lookup = useLookup(search);
  const full = max !== undefined && items.length >= max;
  const have = new Set(items.map(itemKey));
  const fresh = (lookup.results ?? []).filter((option) => !have.has(itemKey(option.value)));
  return (
    <div className="flex flex-col gap-2">
      <Heading label={label} hint={hint} />
      {items.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={itemKey(item)}
              title={itemKey(item)}
              className="flex items-center gap-1.5 rounded-full bg-well py-1 pr-1.5 pl-2.5 text-xs"
            >
              <span>{itemLabel(item)}</span>
              {onChange ? (
                <button
                  type="button"
                  aria-label={`Remove ${itemLabel(item)}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(items.filter((other) => itemKey(other) !== itemKey(item)))
                  }
                  className="grid size-5 cursor-pointer place-items-center rounded-full hover:bg-paper-hi disabled:cursor-default"
                >
                  <Icon icon={X} size={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">None yet.</p>
      )}
      {onChange ? (
        <div className="flex flex-col gap-1">
          <SearchField
            tone="surface"
            label={`Search ${label.toLowerCase()}`}
            placeholder={full ? `At most ${max}` : "Search…"}
            disabled={disabled || full}
            value={lookup.query}
            onValueChange={(next) => {
              lookup.setQuery(next);
              if (!next.trim()) lookup.setResults(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
              if (event.key === "Escape") lookup.setResults(null);
            }}
          />
          {lookup.query.trim() && lookup.results ? (
            <Results
              options={fresh}
              onPick={(option) => {
                onChange([...items, option.value]);
                lookup.reset();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {lookup.error ? <p className="text-xs text-plum-t">{lookup.error}</p> : null}
    </div>
  );
}

type LookupOneProps = LookupFieldProps & { current: unknown; onChange?: (next: unknown) => void };

/** A single setting picked from a search, such as one folder. */
function LookupOne({ label, hint, disabled, search, current, onChange }: LookupOneProps) {
  const lookup = useLookup(search);
  const [picked, setPicked] = useState<LookupOption | null>(null);
  const shown =
    picked && itemKey(picked.value) === itemKey(current)
      ? picked.label
      : current
        ? itemLabel(current)
        : "";
  return (
    <div className="flex flex-col gap-2">
      <Heading label={label} hint={hint} />
      <p className="text-sm">
        {shown ? (
          <span className="font-medium">{shown}</span>
        ) : (
          <span className="text-muted">None picked yet.</span>
        )}
      </p>
      {onChange ? (
        <div className="flex flex-col gap-1">
          <SearchField
            tone="surface"
            label={`Search ${label.toLowerCase()}`}
            placeholder="Search by name, or paste a link…"
            disabled={disabled}
            value={lookup.query}
            onValueChange={(next) => {
              lookup.setQuery(next);
              if (!next.trim()) lookup.setResults(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
              if (event.key === "Escape") lookup.setResults(null);
            }}
          />
          {lookup.query.trim() && lookup.results ? (
            <Results
              options={lookup.results}
              onPick={(option) => {
                setPicked(option);
                onChange(option.value);
                lookup.reset();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {lookup.error ? <p className="text-xs text-plum-t">{lookup.error}</p> : null}
    </div>
  );
}
