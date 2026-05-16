"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * / §5.4 — canonical client-side error boundary.
 *
 * For *route-level* errors prefer Next.js `error.tsx` (App Router's
 * built-in mechanism). Use this component for embedded async client
 * subtrees where a localised error should not unmount the entire page
 * (e.g. a panel inside a detail page).
 *
 * Variants: `"card"` (default) — full alert card + Retry, for panels
 * / async subtrees. `"inline"` — single-line placeholder, no Retry,
 * to isolate one item in a list so a single bad row/card cannot
 * unmount the list; pass `entityType` (+ `rowId`) for structured logs.
 */
interface State {
  error: Error | null;
}

export interface StandardErrorBoundaryProps {
  children: ReactNode;
  /** Heading rendered above the error message. Defaults "Something went wrong". */
  title?: string;
  /** Override the displayed message; defaults to `error.message` then a fallback. */
  fallbackMessage?: string;
  /** Called when the user clicks Retry. */
  onRetry?: () => void;
  /** Optional one-line context tag (e.g. "Loading templates"). */
  context?: string;
  /**
   * Render variant. `"card"` (default) is the full alert card.
   * `"inline"` is a single-line placeholder for per-item isolation
   * inside a list — no message body, no Retry button.
   */
  variant?: "card" | "inline";
  /**
   * Entity name for the structured render-error log (e.g. "lead",
   * "audit_log"). When set, a caught error logs a parseable
   * `[list-render-error]` line instead of the generic boundary line.
   */
  entityType?: string;
  /** Stable id of the item being rendered — included in the error log. */
  rowId?: string;
  /** Which list container logged the error (both render; one CSS-hidden). */
  viewport?: "desktop" | "mobile";
}

export class StandardErrorBoundary extends Component<
  StandardErrorBoundaryProps,
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // diagnostic console.error allowed for client-side fallback
    // observability: the boundary catches errors that would otherwise
    // bubble silently into React's default unhandled-error logger.
    if (this.props.entityType) {
      // Stable-prefixed JSON-shaped line so one bad list item is
      // greppable / parseable for future server-side reporting.
      console.error("[list-render-error]", {
        entityType: this.props.entityType,
        rowId: this.props.rowId,
        viewport: this.props.viewport,
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      });
      return;
    }
    console.error("StandardErrorBoundary caught error", {
      context: this.props.context,
      message: error.message,
    });
  }

  handleRetry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.variant === "inline") {
      // Single line, no message/stack exposed, no Retry (a per-item
      // retry in a virtualized list cannot re-fetch — it would just
      // re-throw). The rest of the list renders normally.
      return (
        <div
          role="status"
          className="bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          Unable to display this item.
        </div>
      );
    }
    const message =
      this.props.fallbackMessage ??
      this.state.error.message ??
      "An unexpected error occurred.";
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
          <span className="font-medium">
            {this.props.title ?? "Something went wrong"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{message}</p>
        <button
          type="button"
          onClick={this.handleRetry}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
        >
          <RotateCw aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
          Retry
        </button>
      </div>
    );
  }
}
