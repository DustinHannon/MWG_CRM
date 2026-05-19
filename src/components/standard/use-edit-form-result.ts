"use client";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ActionFailure, ActionResult } from "@/lib/server-action";

/**
 * Edit forms surface failure as a toast and delegate success to the
 * caller (either via a server-side redirect() in the action, or via
 * the optional `onSuccess` callback when the action only revalidates).
 *
 * Replaces the byte-identical useEffect toast block in the 3 entity
 * edit forms. Errors also flow inline via fieldErrors on the fields;
 * the toast is the summary, the inline message is the locator.
 *
 * `onFailure` is an optional interceptor: return `true` to signal the
 * caller handled the failure itself (e.g. an OCC conflict that opens a
 * resolution dialog instead of a toast) and the default error toast is
 * suppressed; return falsy to fall through to the toast. Keeping this
 * here — rather than each caller hand-rolling its own settle effect —
 * is what keeps every caller compliant with react-hooks/set-state-in-
 * effect (the setState lives in the caller's callback, not an effect).
 */
export function useEditFormResult(
  state: ActionResult,
  onSuccess?: () => void,
  successMessage?: string,
  onFailure?: (failure: ActionFailure) => boolean | void,
) {
  // Initialize to the current state so the mount render is skipped —
  // useActionState's initial value is not null, so seeding with null
  // would fire onSuccess immediately on every page load.
  const seen = useRef<unknown>(state);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    if (state && "ok" in state) {
      if (state.ok === false) {
        const handled = onFailure ? onFailure(state) : false;
        if (!handled) {
          toast.error(state.error, { duration: Infinity, dismissible: true });
        }
      } else {
        if (successMessage) toast.success(successMessage);
        if (onSuccess) onSuccess();
      }
    }
  }, [state, onSuccess, successMessage, onFailure]);
}
