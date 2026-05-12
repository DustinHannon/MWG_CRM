"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createStaticListAction } from "@/app/(app)/marketing/lists/actions";

/**
 * Static-list creation form.
 *
 * Captures name + description, posts to `createStaticListAction`, then
 * redirects to the import wizard (Sub-agent C) at
 * `/marketing/lists/<id>/import` so the user can immediately upload
 * recipients. Users who skip the import land on the detail page where
 * inline edit + manual add work the same way.
 */
export function StaticListCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length === 0) {
      toast.error("Add a name before saving.");
      return;
    }
    startTransition(async () => {
      const result = await createStaticListAction({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("List created.");
      router.push(`/marketing/lists/${result.data.id}/import`);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-w-2xl flex-col gap-5"
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="static-list-name"
          className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
        >
          Name
        </label>
        <input
          id="static-list-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          placeholder="e.g., Texas event invitees 2026"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="static-list-description"
          className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
        >
          Description
        </label>
        <textarea
          id="static-list-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={2}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          placeholder="What this list represents (optional)"
        />
      </div>

      <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        After saving, upload an Excel or CSV file with one row per recipient.
        You can also add or edit recipients directly from the detail page.
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || name.trim().length === 0}
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create list"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          disabled={pending}
          className="inline-flex items-center rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
