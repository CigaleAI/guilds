import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useCreateGuild } from "../../api/queries";
import {
  Button,
  Checkbox,
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
import { handleHint, liveHandleError } from "../names";

/** A new guild: its name, what it is for, and whether only its operators see it. */
export function CreateGuildDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateGuild();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [nameStarted, setNameStarted] = useState(false);
  const nameError = liveHandleError(name, nameStarted);

  const close = () => {
    setName("");
    setAbout("");
    setDescription("");
    setPrivate(true);
    setNameStarted(false);
    create.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (nameError) return;
    create.mutate(
      {
        name: name.trim(),
        about: about.trim(),
        description: description.trim(),
        visibility: isPrivate ? "private" : "org",
      },
      {
        onSuccess: (guild) => {
          close();
          void navigate({ to: "/guilds/$guildId", params: { guildId: guild.id } });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Create a guild"
            description="Name the guild and say what it is for; you become its admin."
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              required
              autoFocus
              autoComplete="off"
              placeholder="research"
              hint={handleHint}
              value={name}
              onChange={(event) => {
                setNameStarted(true);
                setName(event.currentTarget.value);
              }}
              onBlur={() => setNameStarted(true)}
              {...(nameError ? { error: nameError } : {})}
            />
            <TextAreaField
              tone="surface"
              label="Short description"
              font="sans"
              aside="optional"
              rows={2}
              maxLength={200}
              showCount
              placeholder="High-level goal for everyone in this guild"
              hint="Shown in the guild header and to agents."
              value={about}
              onChange={(event) => setAbout(event.currentTarget.value)}
            />
            <TextAreaField
              tone="surface"
              label="Description"
              aside="optional · markdown"
              font="mono"
              rows={5}
              maxLength={8000}
              showCount
              placeholder="What this guild is for, how it should work, constraints"
              hint="Agents read it on every run; edit it later in Settings."
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            <div className="flex flex-col gap-1">
              <Checkbox
                label="Private"
                checked={isPrivate}
                onCheckedChange={(next) => setPrivate(next === true)}
              />
              <p className="pl-7 text-sm text-fg-2">
                Only the guild's operators can see it. You can add operators from Settings.
              </p>
            </div>
            {create.isError ? (
              <Banner tone="error" title="Couldn't create the guild">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || !name.trim() || Boolean(nameError)}>
              {create.isPending ? "Creating…" : "Create guild"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
