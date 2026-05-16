// consistency-exempt: import-wizard-scaffold: Entra directory sync has no file-upload stage and presents a dual-list (import candidates + offboard) review the single-renderPreview ImportWizard contract cannot express; reuses StandardListPage and every other canonical primitive.
"use client";

import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { StandardPageHeader } from "@/components/standard";
import {
  loadEntraSyncPreview,
  commitEntraUserImport,
  offboardMissingUsers,
  type EntraSyncPreview,
  type CommitResult,
  type OffboardResult,
} from "../actions";
import { SyncCandidateList } from "./sync-candidate-list";
import { OffboardList } from "./offboard-list";

type Stage = "idle" | "review" | "done";

export function EntraSyncClient() {
  const [stage, setStage] = useState<Stage>("idle");
  const [preview, setPreview] = useState<EntraSyncPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [offboardDecisions, setOffboardDecisions] = useState<
    Map<string, string | null>
  >(new Map());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [importFailures, setImportFailures] = useState<
    CommitResult["failed"]
  >([]);
  const [offboardFailures, setOffboardFailures] = useState<
    OffboardResult["failed"]
  >([]);

  const handleToggle = useCallback((entraOid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entraOid)) {
        next.delete(entraOid);
      } else {
        next.add(entraOid);
      }
      return next;
    });
  }, []);

  const handleOffboardChange = useCallback(
    (userId: string, reassignTo: string | null) => {
      setOffboardDecisions((prev) => {
        const next = new Map(prev);
        next.set(userId, reassignTo);
        return next;
      });
    },
    [],
  );

  const handleLoad = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const res = await loadEntraSyncPreview();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const p = res.data;
      setPreview(p);
      setSelected(
        new Set(
          p.candidates
            .filter((c) => c.recommended)
            .map((c) => c.entraOid),
        ),
      );
      setOffboardDecisions(new Map());
      setStage("review");
      if (p.permissionError) {
        setError(p.permissionError);
      }
    });
  }, []);

  const handleCommit = useCallback(() => {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const importRes = await commitEntraUserImport({
        entraOids: [...selected],
      });
      if (!importRes.ok) {
        toast.error(importRes.error, {
          duration: Infinity,
          dismissible: true,
        });
        return;
      }
      const { created, updated, failed } = importRes.data;
      setImportFailures(failed);

      const items = [...offboardDecisions.entries()].map(
        ([userId, reassignTo]) => ({ userId, reassignTo }),
      );

      let deactivated = 0;
      let reassigned = 0;
      let offboardFailed: OffboardResult["failed"] = [];
      if (items.length > 0) {
        const offboardRes = await offboardMissingUsers({ items });
        if (!offboardRes.ok) {
          toast.error(offboardRes.error, {
            duration: Infinity,
            dismissible: true,
          });
          return;
        }
        deactivated = offboardRes.data.deactivated;
        reassigned = offboardRes.data.reassigned;
        offboardFailed = offboardRes.data.failed;
      }
      setOffboardFailures(offboardFailed);

      const base = `${created} created, ${updated} updated, ${failed.length} failed`;
      const offboardPart =
        items.length > 0
          ? ` · ${deactivated} deactivated, ${reassigned} reassigned`
          : "";
      setResult(`${base}${offboardPart}`);
      setStage("done");
      toast.success("Entra sync complete");
    });
  }, [preview, selected, offboardDecisions]);

  const handleReset = useCallback(() => {
    setStage("idle");
    setPreview(null);
    setSelected(new Set());
    setOffboardDecisions(new Map());
    setError(null);
    setResult(null);
    setImportFailures([]);
    setOffboardFailures([]);
  }, []);

  if (stage === "idle") {
    return (
      <div className="flex flex-col gap-4">
        <StandardPageHeader
          title="Sync users from Entra"
          description="Read the Entra directory, create CRM accounts now with default access, and deactivate users who have left."
        />
        {error ? (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div>
          <button
            type="button"
            onClick={handleLoad}
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Loading Entra directory" : "Load Entra directory"}
          </button>
        </div>
      </div>
    );
  }

  if (stage === "review" && preview) {
    const recommended = preview.candidates.filter(
      (c) => c.recommended,
    ).length;
    return (
      <div className="flex flex-col gap-6">
        <StandardPageHeader
          title="Review Entra sync"
          description={`${selected.size} selected · ${recommended} recommended · ${preview.candidates.length} in directory`}
        />
        {error ? (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div>
          <button
            type="button"
            onClick={handleCommit}
            disabled={pending || selected.size === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {`Import ${selected.size} and apply offboarding`}
          </button>
        </div>
        <SyncCandidateList
          candidates={preview.candidates}
          selected={selected}
          onToggle={handleToggle}
        />
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Users missing from Entra
          </h2>
          <OffboardList
            offboard={preview.offboard}
            reassignTargets={preview.reassignTargets}
            decisions={offboardDecisions}
            onChange={handleOffboardChange}
          />
        </section>
      </div>
    );
  }

  const hasFailures =
    importFailures.length > 0 || offboardFailures.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <StandardPageHeader title="Entra sync complete" />
      <p className="text-sm text-muted-foreground">{result}</p>
      {hasFailures ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-4 py-3">
          <p className="text-sm text-destructive">
            Some users could not be processed:
          </p>
          <ul className="flex flex-col gap-1">
            {importFailures.map((f) => (
              <li
                key={`import-${f.entraOid}`}
                className="text-sm text-muted-foreground"
              >
                {f.entraOid}: {f.error}
              </li>
            ))}
            {offboardFailures.map((f) => (
              <li
                key={`offboard-${f.userId}`}
                className="text-sm text-muted-foreground"
              >
                {f.userId}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <button
          type="button"
          onClick={handleReset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Run again
        </button>
      </div>
    </div>
  );
}
