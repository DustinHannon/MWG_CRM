"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { TagChip } from "./tag-chip";
import { TagColorPicker } from "./tag-color-picker";
import {
  changeTagColorAction,
  deleteTagAction,
  renameTagAction,
} from "./actions";

interface TagEditModalProps {
  tag: { id: string; name: string; color: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful rename/recolour so parents can refresh. */
  onUpdated?: (next: { id: string; name: string; color: string }) => void;
  /** Called after a successful delete so parents can dismiss the row. */
  onDeleted?: (tagId: string) => void;
}

/**
 * Governance modal wrapper — relies on a per-tag key so React resets
 * draft state when a different tag is opened, instead of running an
 * effect to sync state.
 */
export function TagEditModal(props: TagEditModalProps) {
  return <TagEditModalInner key={props.tag.id} {...props} />;
}

function TagEditModalInner({
  tag,
  open,
  onOpenChange,
  onUpdated,
  onDeleted,
}: TagEditModalProps) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const nameChanged = name.trim() !== tag.name && name.trim().length > 0;
  const colorChanged = color !== tag.color && color.length > 0;

  function handleSaveName() {
    if (!nameChanged) return;
    startTransition(async () => {
      const res = await renameTagAction({
        tagId: tag.id,
        newName: name.trim(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Tag renamed");
      onUpdated?.({
        id: res.data.id,
        name: res.data.name,
        color: res.data.color,
      });
    });
  }

  function handleSaveColor() {
    if (!colorChanged) return;
    startTransition(async () => {
      const res = await changeTagColorAction({
        tagId: tag.id,
        newColor: color,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Tag colour updated");
      onUpdated?.({
        id: res.data.id,
        name: res.data.name,
        color: res.data.color,
      });
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteTagAction({ tagId: tag.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Tag deleted");
      setConfirmOpen(false);
      onOpenChange(false);
      onDeleted?.(tag.id);
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Title className="text-sm font-semibold text-foreground">
            Edit tag
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Changes apply to every record that uses this tag.
          </Dialog.Description>

          <div className="mt-4 flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Preview
            </span>
            <TagChip name={name || tag.name} color={color || tag.color} />
          </div>

          <section className="mt-5 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Name
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={50}
                className="h-9 flex-1 rounded-md border border-border bg-input/60 px-3 text-sm"
              />
              <button
                type="button"
                disabled={pending || !nameChanged}
                onClick={handleSaveName}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Rename
              </button>
            </div>
          </section>

          <section className="mt-5 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Colour
            </h3>
            <TagColorPicker value={color} onChange={setColor} />
            <div>
              <button
                type="button"
                disabled={pending || !colorChanged}
                onClick={handleSaveColor}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save colour
              </button>
            </div>
          </section>

          <section className="mt-6 border-t border-border pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-destructive">
              Delete
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Removes this tag from every record. This cannot be undone.
            </p>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
              className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Delete tag
            </button>
          </section>

          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
              >
                Close
              </button>
            </Dialog.Close>
          </div>

          <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
                <AlertDialog.Title className="text-base font-semibold text-foreground">
                  Delete this tag?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
                  This tag will be removed from every record that uses it.
                </AlertDialog.Description>
                <div className="mt-5 flex justify-end gap-2">
                  <AlertDialog.Cancel asChild>
                    <button
                      type="button"
                      className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </AlertDialog.Cancel>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={pending}
                    className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {pending ? "Deleting…" : "Delete tag"}
                  </button>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
