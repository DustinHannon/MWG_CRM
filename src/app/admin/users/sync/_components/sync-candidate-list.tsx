"use client";

import { useCallback, useMemo } from "react";
import {
  StandardListPage,
  StandardEmptyState,
} from "@/components/standard";
import type { SyncCandidate } from "../actions";

interface SyncCandidateFilters {
  q: string;
}

interface SyncCandidateListProps {
  candidates: SyncCandidate[];
  selected: Set<string>;
  onToggle: (entraOid: string) => void;
}

export function SyncCandidateList({
  candidates,
  selected,
  onToggle,
}: SyncCandidateListProps) {
  const filters = useMemo<SyncCandidateFilters>(() => ({ q: "" }), []);

  const fetchPage = useCallback(
    async (
      _cursor: string | null,
      f: SyncCandidateFilters,
    ): Promise<{
      data: SyncCandidate[];
      nextCursor: string | null;
      total: number;
    }> => {
      const query = f.q.trim().toLowerCase();
      const filtered = query
        ? candidates.filter(
            (c) =>
              c.displayName.toLowerCase().includes(query) ||
              c.email.toLowerCase().includes(query),
          )
        : candidates;
      return { data: filtered, nextCursor: null, total: filtered.length };
    },
    [candidates],
  );

  const getRowId = useCallback((c: SyncCandidate) => c.entraOid, []);

  const renderRow = useCallback(
    (c: SyncCandidate) => {
      const reasons = c.reasons.length ? c.reasons.join("; ") : "Recommended";
      return (
        <div className="flex items-center gap-3 px-4 py-3 text-sm">
          <input
            type="checkbox"
            aria-label={`Import ${c.displayName}`}
            checked={selected.has(c.entraOid)}
            onChange={() => onToggle(c.entraOid)}
            className="size-4 shrink-0 accent-primary"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-foreground">
              {c.displayName}
            </div>
            <div className="truncate text-muted-foreground">{c.email}</div>
          </div>
          <div className="hidden min-w-0 flex-1 truncate text-muted-foreground md:block">
            {c.jobTitle ?? ""}
          </div>
          <div className="hidden min-w-0 flex-1 truncate text-muted-foreground lg:block">
            {reasons}
          </div>
        </div>
      );
    },
    [selected, onToggle],
  );

  const renderCard = useCallback(
    (c: SyncCandidate) => {
      const reasons = c.reasons.length ? c.reasons.join("; ") : "Recommended";
      return (
        <div className="flex items-start gap-3 px-4 py-3 text-sm">
          <input
            type="checkbox"
            aria-label={`Import ${c.displayName}`}
            checked={selected.has(c.entraOid)}
            onChange={() => onToggle(c.entraOid)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="truncate font-medium text-foreground">
              {c.displayName}
            </div>
            <div className="truncate text-muted-foreground">{c.email}</div>
            {c.jobTitle ? (
              <div className="truncate text-muted-foreground">
                {c.jobTitle}
              </div>
            ) : null}
            <div className="text-muted-foreground">{reasons}</div>
          </div>
        </div>
      );
    },
    [selected, onToggle],
  );

  return (
    <StandardListPage<SyncCandidate, SyncCandidateFilters>
      entityType="entra_sync_candidate"
      queryKey={["entra-sync-candidates", candidates.length]}
      fetchPage={fetchPage}
      filters={filters}
      getRowId={getRowId}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={96}
      emptyState={
        <StandardEmptyState
          title="No directory users"
          description="No users were returned from Entra, or all are filtered out."
        />
      }
      header={{ title: "Select users to import" }}
    />
  );
}
