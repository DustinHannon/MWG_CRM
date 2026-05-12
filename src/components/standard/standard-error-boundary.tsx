"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Component, type ReactNode } from "react";

/**
 * / §5.4 — canonical client-side error boundary.
 *
 * For *route-level* errors prefer Next.js `error.tsx` (App Router's
 * built-in mechanism). Use this component for embedded async client
 * subtrees where a localised error should not unmount the entire page
 * (e.g. a panel inside a detail page).
 *
 * Renders a card with an icon, the error message (or a generic
 * fallback), and a Retry button that calls `onRetry` if provided. If
 * no `onRetry` is given, Retry reloads the boundary via state reset
 * so the children re-mount.
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
}

export class StandardErrorBoundary extends Component<
  StandardErrorBoundaryProps,
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(): void {
    // diagnostic console.error allowed for client-side
    // fallback observability when no `onError` callback is wired in.
    // Reason: the boundary catches errors that would otherwise bubble
    // silently into React's default unhandled-error logger.
    console.error("StandardErrorBoundary caught error", {
      context: this.props.context,
      message: this.state.error?.message,
    });
  }

  handleRetry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
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
