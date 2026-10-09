import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button } from "../actions/Button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "./Dialog";
import { dismissToast, toast, type ToastOptions } from "./toast";
import { Toaster } from "./Toaster";

const meta: Meta<typeof Toaster> = {
  title: "Components/Overlays/Toast",
  component: Toaster,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Toaster>;

const unreachable: ToastOptions = {
  kind: "error",
  title: "Couldn’t reach coingecko",
  description: "MCP server returned 401",
  action: { label: "Retry", onClick: () => {} },
};

const samples: ToastOptions[] = [
  unreachable,
  {
    kind: "warning",
    title: "wallet hit max_tokens",
    description: "The turn used its full output budget",
    action: { label: "Open run", onClick: () => {} },
  },
  { kind: "info", title: "researchoor woke up", description: "mention from managooor" },
  {
    kind: "success",
    title: "Routine saved",
    description: "Daily retrospective · next run 00:00",
    action: { label: "Undo", onClick: () => {}, altText: "Delete the routine from the Routines tab" },
  },
];

function Launcher() {
  return (
    <div className="flex h-screen flex-col items-start gap-3 p-6">
      <div className="flex flex-wrap gap-2 rounded-xl bg-surface p-5">
        {samples.map((sample) => (
          <Button key={sample.kind} variant="outline" onClick={() => toast(sample)}>
            {sample.kind}
          </Button>
        ))}
      </div>
      <Toaster />
    </div>
  );
}

function AllKinds() {
  useEffect(() => {
    const ids = samples.map((sample) => toast(sample));
    return () => ids.forEach(dismissToast);
  }, []);
  return <Launcher />;
}

export const Kinds: Story = {
  render: () => <AllKinds />,
};

function OverDialog() {
  useEffect(() => {
    const id = toast(unreachable);
    return () => dismissToast(id);
  }, []);
  return (
    <div className="h-screen p-6">
      <Dialog defaultOpen>
        <DialogContent size="sm">
          <DialogHeader title="Connect coingecko" description="MCP server · guild scope" />
          <DialogBody>The server answered 401. Check the API key in Secrets, then retry.</DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg" variant="ghost">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Toaster />
    </div>
  );
}

/** Toasts stay clickable above an open dialog, and dismissing one leaves the dialog open. */
export const AboveADialog: Story = {
  render: () => <OverDialog />,
};

export const Playground: Story = {
  render: () => <Launcher />,
};
