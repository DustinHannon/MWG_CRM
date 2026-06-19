"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Canonical content dialog. Wraps `@radix-ui/react-dialog` so focus trap,
 * Escape-to-close, focus restoration on close, body scroll lock, portal
 * placement, and aria wiring all come for free — the failure mode that a
 * dozen hand-rolled `<div role="dialog">` overlays each reimplemented and
 * each got partly wrong (no trap, Tab leaks behind the scrim, focus never
 * restored to the trigger).
 *
 * Use for non-confirmation modals: forms, pickers, detail panels, test-send
 * dialogs. For a destructive yes/no confirm use `StandardConfirmDialog`; for
 * entity archive/delete use `ConfirmDeleteDialog`.
 *
 * Drive it controlled (`open` + `onOpenChange`) or trigger-driven (`trigger`).
 * Keep the existing inner content and submit logic; this owns only the overlay,
 * panel chrome, and focus management. The panel caps at 85vh and scrolls its
 * body internally — that is overlay behavior, not a list/detail page scroll
 * surface, so it is not a §16 nested-scroll violation.
 */
export interface StandardDialogProps {
  /** Controlled open state. Omit for trigger-driven dialogs. */
  open?: boolean;
  /** Controlled open-change handler (Escape, close button, outside click, trigger). */
  onOpenChange?: (open: boolean) => void;
  /** Optional inline trigger, rendered `asChild`. Omit for controlled dialogs. */
  trigger?: ReactNode;
  /** Accessible title — required by Radix for screen readers even when hidden. */
  title: ReactNode;
  /** Visually hide the title (still announced) when the design has no header text. */
  hideTitle?: boolean;
  /** Optional sub-text rendered under the title. */
  description?: ReactNode;
  /** Dialog body. */
  children: ReactNode;
  /** Optional footer button row, rendered right-aligned below the body. */
  footer?: ReactNode;
  /** Show the corner close (×) button. Default true. */
  showCloseButton?: boolean;
  /** Extra classes for the content panel (e.g. a wider `sm:max-w-3xl`). */
  contentClassName?: string;
  /** Prevent dismiss on outside-click. Escape and the close button still work. */
  disableOutsideClose?: boolean;
}

const OVERLAY_CLASS =
  "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

const CONTENT_CLASS =
  "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background p-5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

export function StandardDialog({
  open,
  onOpenChange,
  trigger,
  title,
  hideTitle,
  description,
  children,
  footer,
  showCloseButton = true,
  contentClassName,
  disableOutsideClose,
}: StandardDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          className={`${CONTENT_CLASS}${contentClassName ? ` ${contentClassName}` : ""}`}
          // When there is no Description, opt out of Radix's describedby
          // requirement to avoid the dev-only missing-description warning.
          {...(description ? {} : { "aria-describedby": undefined })}
          onInteractOutside={
            disableOutsideClose ? (e) => e.preventDefault() : undefined
          }
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title
                className={
                  hideTitle ? "sr-only" : "text-sm font-semibold text-foreground"
                }
              >
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            {showCloseButton ? (
              <Dialog.Close
                aria-label="Close"
                className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            ) : null}
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? (
            <div className="mt-4 flex flex-shrink-0 justify-end gap-2">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Re-export so trigger-driven dialogs can close from a custom footer button. */
export const StandardDialogClose = Dialog.Close;
