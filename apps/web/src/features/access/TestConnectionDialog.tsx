import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { callConnectionTool } from "../../api/queries";
import type { McpServerAccess, McpToolAccess, McpToolCallResult } from "../../api/types";
import {
  Button,
  CopyButton,
  JsonTree,
  Select,
  TextAreaField,
  TextField,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@guildsrun/ui";
import {
  emptyArgValues,
  fieldsFromSchema,
  parseArgValues,
  prettyResult,
  type ArgField,
} from "./toolArgs";

const unset = "__unset__";

function ArgInput({
  field,
  value,
  onChange,
}: {
  field: ArgField;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = field.required ? `${field.name} *` : field.name;
  const common = { label, hint: field.description, tone: "surface" as const };
  if (field.kind === "boolean" || field.kind === "enum") {
    const options =
      field.kind === "boolean"
        ? [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]
        : (field.values ?? []).map((item) => ({ value: item, label: item }));
    return (
      <Select
        {...common}
        mono
        value={value || unset}
        onValueChange={(next) => onChange(next === unset ? "" : next)}
        options={field.required ? options : [{ value: unset, label: "(not set)" }, ...options]}
      />
    );
  }
  if (field.kind === "json") {
    return (
      <TextAreaField
        {...common}
        font="mono"
        rows={field.name === "arguments" ? 8 : 4}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        spellCheck={false}
      />
    );
  }
  return (
    <TextField
      {...common}
      mono
      type={field.kind === "string" ? "text" : "number"}
      step={field.kind === "integer" ? "1" : field.kind === "number" ? "any" : undefined}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function ResultView({ result }: { result: McpToolCallResult }) {
  const shown = prettyResult(result.content);
  const structured = shown.json !== null && typeof shown.json === "object";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Result</span>
        {result.truncated ? <span className="text-xs text-muted">truncated</span> : null}
        <CopyButton className="ml-auto" text={result.content} what="result" />
      </div>
      {structured ? (
        <div className="max-h-80 overflow-auto rounded-md bg-surface p-3">
          <JsonTree value={shown.json} />
        </div>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {shown.text || "(empty)"}
        </pre>
      )}
    </div>
  );
}

export type TestConnectionDialogProps = {
  server: McpServerAccess;
  /** The function to call; omit it to pick from the server's list. */
  tool?: McpToolAccess | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Fills one function's arguments and calls it on the integration's connected login. */
export function TestConnectionDialog({
  server,
  tool = null,
  open,
  onOpenChange,
}: TestConnectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-3rem)]">
        {open ? <TestConnectionForm key={tool?.name ?? ""} server={server} tool={tool} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TestConnectionForm({
  server,
  tool,
}: {
  server: McpServerAccess;
  tool: McpToolAccess | null;
}) {
  const [selected, setSelected] = useState<McpToolAccess | null>(tool);
  const [values, setValues] = useState(() => emptyArgValues(fieldsFromSchema(tool?.input_schema)));
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<McpToolCallResult | null>(null);
  const fields = useMemo(() => fieldsFromSchema(selected?.input_schema), [selected]);
  const call = useMutation({
    mutationFn: ({ name, arguments_ }: { name: string; arguments_: Record<string, unknown> }) =>
      callConnectionTool(server.connection_id ?? "", name, arguments_),
  });

  const selectTool = (next: McpToolAccess | null) => {
    setSelected(next);
    setValues(emptyArgValues(fieldsFromSchema(next?.input_schema)));
    setProblem(null);
    setResult(null);
    call.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !server.connection_id) return;
    const parsed = parseArgValues(fields, values);
    if ("error" in parsed) {
      setProblem(parsed.error);
      return;
    }
    setProblem(null);
    setResult(null);
    call.mutate({ name: selected.name, arguments_: parsed.arguments }, { onSuccess: setResult });
  };

  const picking = selected === null;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DialogHeader
        title={picking ? `Test ${server.name}` : selected.name}
        description={
          picking ? "Pick a function to call on this login." : "Calls the connected login."
        }
      />
      <DialogBody>
        {picking ? (
          server.tools.length ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg bg-surface">
              {server.tools.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => selectTool(item)}
                  className="flex flex-col gap-0.5 border-b border-line px-3.5 py-3 text-left last:border-b-0 hover:bg-paper"
                >
                  <span className="font-mono text-sm font-medium wrap-anywhere text-fg">
                    {item.name}
                  </span>
                  {item.description ? (
                    <span className="line-clamp-2 text-xs text-fg-2">{item.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">This login has no listed functions yet.</p>
          )
        ) : (
          <>
            {selected.description ? (
              <p className="text-sm text-fg-2">{selected.description}</p>
            ) : null}
            {fields.map((field) => (
              <ArgInput
                key={field.name}
                field={field}
                value={values[field.name] ?? ""}
                onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
              />
            ))}
            {problem ? <p className="text-sm text-plum-t">{problem}</p> : null}
            {call.isError ? (
              <Banner tone="error" title="Couldn't call the function">
                {call.error.message}
              </Banner>
            ) : null}
            {result ? <ResultView result={result} /> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {picking ? (
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        ) : (
          <>
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={call.isPending}
              onClick={() => selectTool(null)}
            >
              Back
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" disabled={call.isPending}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={call.isPending || !server.connection_id}>
              {call.isPending ? "Calling…" : "Call"}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}
