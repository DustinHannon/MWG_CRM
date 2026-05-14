import { useEffect, type RefObject } from "react";

/**
 * Dismisses a popover when the user clicks outside the referenced element.
 *
 * Why a document-level listener instead of a `fixed inset-0` backdrop button:
 * a sticky parent with `z-20` creates a new stacking context, and any `fixed`
 * backdrop rendered inside it is bound by the parent's effective z-index. The
 * virtualized row list sits below the sticky parent but renders ABOVE the
 * backdrop in the visual stack, so clicks land on rows instead of the backdrop
 * and the popover never closes.
 *
 * The document-level mousedown handler bypasses the stacking-context bind:
 * it fires from `document` regardless of which painted element is on top.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean = true,
) {
  useEffect(() => {
    if (!active) return;
    const onMouseDown = (e: MouseEvent) => {
      const node = ref.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [ref, onClose, active]);
}
