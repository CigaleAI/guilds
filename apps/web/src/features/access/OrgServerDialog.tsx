import { useState, type FormEvent } from "react";
import { useAddOrgServer, type OrgServerInput } from "../../api/queries";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Select,
  TextAreaField,
  TextField,
  toast,
} from "@guildsrun/ui";

const empty: OrgServerInput = {
  slug: "",
  display_name: "",
  url: "",
  auth: "token",
  description: "",
};

/**
 * Adds a remote MCP server for this organisation alone: a URL on public HTTPS and how it signs
 * in. A blank name and description fill in from the server once a login connects.
 */
export function OrgServerDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const add = useAddOrgServer(orgId);
  const [form, setForm] = useState<OrgServerInput>(empty);
  const set = (patch: Partial<OrgServerInput>) => setForm({ ...form, ...patch });

  const close = () => {
    setForm(empty);
    add.reset();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      {
        ...form,
        slug: form.slug.trim(),
        display_name: form.display_name.trim() || form.slug.trim(),
      },
      {
        onSuccess: () => {
          toast({
            kind: "success",
            title: `${form.display_name.trim() || form.slug.trim()} added`,
          });
          close();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Add a remote server"
            description="An MCP server on public HTTPS for this organisation only. Its tools reach your Builder and Studio once you connect it."
          />
          <DialogBody>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                tone="surface"
                label="Slug"
                mono
                required
                hint="Lowercase letters, digits, and underscores."
                value={form.slug}
                onChange={(event) => set({ slug: event.currentTarget.value })}
              />
              <TextField
                tone="surface"
                label="Display name (optional)"
                value={form.display_name}
                onChange={(event) => set({ display_name: event.currentTarget.value })}
              />
            </div>
            <TextField
              tone="surface"
              label="URL"
              mono
              required
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(event) => set({ url: event.currentTarget.value })}
            />
            <Select
              tone="surface"
              label="Sign-in"
              value={form.auth}
              onValueChange={(value) => set({ auth: value as OrgServerInput["auth"] })}
              options={[
                { value: "token", label: "An API key or token" },
                { value: "oauth", label: "OAuth at the server" },
                { value: "none", label: "None" },
              ]}
            />
            <TextAreaField
              tone="surface"
              font="sans"
              label="Description (optional)"
              rows={2}
              value={form.description}
              onChange={(event) => set({ description: event.currentTarget.value })}
            />
            {add.isError ? (
              <Banner tone="error" title="Couldn't add the server">
                {add.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={add.isPending}>
              Add server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
