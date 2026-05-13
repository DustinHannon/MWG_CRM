"use client";

import {
  createContext,
  useCallback,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type {
  SelectionAction,
  SelectionContextValue,
  SelectionState,
} from "./types";

/**
 * Reducer for the four-state selection machine. Centralised so the
 * provider stays a thin shell over `useReducer`.
 *
 * State transition rules:
 *   - `toggle_individual` always lands in `individual` scope, even
 *     from `all_loaded` / `all_matching`. The set becomes the
 *     symmetric difference of "previously implied" minus the toggled
 *     id, which we approximate by treating the upgraded scopes as
 *     "everything except the toggled id" → falls back to a new
 *     individual set containing the toggled id. Consumers that want
 *     "deselect one row from all_matching" should clear and re-select
 *     individually; this is intentional because partial-deselection
 *     from `all_matching` cannot be represented with a finite id set.
 *   - `select_all_loaded` always lands in `all_loaded`, regardless of
 *     prior scope.
 *   - `select_all_matching` always lands in `all_matching` with the
 *     `estimatedTotal` from the dispatch.
 *   - `clear` always lands in `none`.
 *   - `sync_load_state` does not change scope — only updates the
 *     loaded / total counters. Consumers dispatch this from their
 *     fetchPage callback so the banner / toolbar can render accurate
 *     counts.
 */
function reducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "toggle_individual": {
      if (state.scope.kind === "individual") {
        const next = new Set(state.scope.ids);
        if (next.has(action.id)) next.delete(action.id);
        else next.add(action.id);
        if (next.size === 0) {
          return { ...state, scope: { kind: "none" } };
        }
        return { ...state, scope: { kind: "individual", ids: next } };
      }
      // From any non-individual scope, a toggle starts a fresh
      // explicit set with just the toggled id. See the doctrine
      // comment above for why this is intentional.
      return {
        ...state,
        scope: { kind: "individual", ids: new Set([action.id]) },
      };
    }

    case "select_all_loaded":
      return { ...state, scope: { kind: "all_loaded" } };

    case "select_all_matching":
      return {
        ...state,
        scope: {
          kind: "all_matching",
          estimatedTotal: action.estimatedTotal,
        },
      };

    case "clear":
      return { ...state, scope: { kind: "none" } };

    case "sync_load_state":
      return {
        ...state,
        loadedCount: action.loadedCount,
        total: action.total,
      };

    default:
      return state;
  }
}

const initialState: SelectionState = {
  scope: { kind: "none" },
  loadedCount: 0,
  total: 0,
};

export const BulkSelectionContext = createContext<SelectionContextValue | null>(
  null,
);
BulkSelectionContext.displayName = "BulkSelectionContext";

/**
 * Provider for the bulk selection state machine. Wraps any subtree
 * that participates in selection (typically the entire list page
 * including the toolbar and per-row checkboxes).
 *
 * Provider keeps its own state — it does not subscribe to filter
 * state. Consumers MUST dispatch `{ type: "clear" }` from their
 * filter change handler so a leftover `all_loaded` scope doesn't
 * leak into the next result set.
 */
export function BulkSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const isSelected = useCallback(
    (id: string): boolean => {
      switch (state.scope.kind) {
        case "none":
          return false;
        case "individual":
          return state.scope.ids.has(id);
        case "all_loaded":
        case "all_matching":
          return true;
      }
    },
    [state.scope],
  );

  const value = useMemo<SelectionContextValue>(
    () => ({ ...state, dispatch, isSelected }),
    [state, isSelected],
  );

  return (
    <BulkSelectionContext.Provider value={value}>
      {children}
    </BulkSelectionContext.Provider>
  );
}
