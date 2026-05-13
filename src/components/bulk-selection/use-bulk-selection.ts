"use client";

import { useContext } from "react";
import { BulkSelectionContext } from "./bulk-selection-provider";
import type { SelectionContextValue } from "./types";

/**
 * Hook reading the bulk selection context. Throws when used outside
 * `<BulkSelectionProvider>` so consumers fail loudly during dev
 * rather than silently rendering an inert toolbar.
 */
export function useBulkSelection(): SelectionContextValue {
  const ctx = useContext(BulkSelectionContext);
  if (!ctx) {
    throw new Error(
      "useBulkSelection must be used inside <BulkSelectionProvider>.",
    );
  }
  return ctx;
}
