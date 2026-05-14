import { useCallback } from "react";
import type { MouseEvent } from "react";

/**
 * Wires `<input type="datetime-local">` and `<input type="date">` so a
 * click anywhere on the input bar opens the native picker — not only
 * the trailing calendar icon.
 *
 * Browser support: `showPicker()` is Chrome 99+ / Firefox 101+ / Safari 16+;
 * older releases fall through to the default icon-click behavior. The call
 * is wrapped in `try / catch` because the DOM method throws when the input
 * is disabled, hidden, or the user-activation rules aren't met for the
 * current gesture — the throw is benign and the native behavior takes
 * over.
 *
 * Returns a memoized click handler. The handler reads the target input
 * element from `event.currentTarget` so no `ref` is required at the
 * call site — `<input type="date" onClick={openDatePicker} />` is the
 * full wiring.
 *
 * STANDARDS §17.2 governs the contract.
 */
export function useShowPicker() {
  return useCallback((event: MouseEvent<HTMLInputElement>) => {
    const node = event.currentTarget;
    if (!("showPicker" in node)) return;
    try {
      node.showPicker();
    } catch {
      /* showPicker() throws on disabled/hidden inputs or
         user-activation edge cases — native click falls through. */
    }
  }, []);
}
