"use client";

/**
 * Public API documentation page (`/apihelp`).
 *
 * Renders Scalar's interactive API reference against the live
 * OpenAPI 3.1 spec served at `/api/openapi.json`. The Scalar
 * component is client-only, so this whole route is a Client
 * Component. No `requireSession()` is called — the page is
 * reachable logged-out, by design.
 *
 * Theming approach
 * ----------------
 * Scalar exposes its internal palette via a fixed set of CSS
 * variables (--scalar-color-1, --scalar-color-2, --scalar-background-1,
 * etc.) under both light (`.light-mode`) and dark (`.dark-mode`)
 * scopes. We override those variables with the MWG semantic tokens
 * declared in `globals.css` so Scalar adopts our palette and
 * follows the user's theme automatically (next-themes flips
 * `.dark` on <html>; our overrides match both modes).
 *
 * The `customCss` configuration field is the supported way to
 * inject this stylesheet into the embedded reference.
 */

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import Image from "next/image";
import Link from "next/link";

const SCALAR_THEME_OVERRIDES = `
/* Map Scalar's theme tokens onto MWG semantic tokens so the embedded
 * reference inherits our brand palette in light AND dark mode.
 * The .light-mode / .dark-mode scopes are emitted by Scalar itself;
 * we duplicate the mapping under both so flipping next-themes works
 * regardless of which scope Scalar resolves to first. */

.scalar-app,
.light-mode,
.dark-mode {
  --scalar-font: var(--font-sans);
  --scalar-font-code: var(--font-mono);
  --scalar-radius: var(--radius);
  --scalar-radius-lg: var(--radius);
  --scalar-radius-xl: calc(var(--radius) + 2px);

  --scalar-color-1: var(--foreground);
  --scalar-color-2: var(--foreground);
  --scalar-color-3: var(--muted-foreground);
  --scalar-color-accent: var(--primary);

  --scalar-background-1: var(--background);
  --scalar-background-2: var(--card);
  --scalar-background-3: var(--muted);
  --scalar-background-accent: color-mix(in oklab, var(--primary) 15%, transparent);

  --scalar-border-color: var(--border);

  --scalar-button-1: var(--primary);
  --scalar-button-1-color: var(--primary-foreground);
  --scalar-button-1-hover: color-mix(in oklab, var(--primary) 85%, black);

  --scalar-color-green: oklch(0.65 0.18 145);
  --scalar-color-red: var(--destructive);
  --scalar-color-yellow: oklch(0.75 0.15 90);
  --scalar-color-blue: oklch(0.65 0.15 250);
  --scalar-color-orange: oklch(0.70 0.18 50);
  --scalar-color-purple: oklch(0.65 0.18 290);

  --scalar-sidebar-background-1: var(--card);
  --scalar-sidebar-item-hover-background: var(--accent);
  --scalar-sidebar-item-active-background: var(--accent);
  --scalar-sidebar-color-1: var(--foreground);
  --scalar-sidebar-color-2: var(--muted-foreground);
  --scalar-sidebar-color-active: var(--foreground);
  --scalar-sidebar-search-background: var(--input);
  --scalar-sidebar-search-color: var(--foreground);
  --scalar-sidebar-search-border-color: var(--border);
  --scalar-sidebar-border-color: var(--border);
}

/* Embed the Scalar surface so it participates in the page flow without
 * fighting the body gradient backdrop. */
.scalar-api-reference {
  background: transparent;
}
`;

export default function ApiHelpPage() {
  return (
    <main className="min-h-screen">
      {/* Header / quickstart container */}
      <section className="mx-auto w-full max-w-4xl px-6 py-12">
        <header className="mb-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <Link
            href="/"
            aria-label="Morgan White Group"
            className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-card p-2 text-foreground"
          >
            {/* The logo asset ships with a hardcoded white silhouette + navy
             * accent. Wrapping in a card surface keeps it legible in both
             * light and dark modes without per-theme image swapping. */}
            <Image
              src="/brand/mwg-logo.svg"
              alt=""
              width={56}
              height={56}
              className="h-full w-full object-contain"
              priority
            />
          </Link>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Public REST API • v1
            </p>
            <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-foreground">
              MWG CRM API
            </h1>
          </div>
        </header>

        <p className="text-base leading-relaxed text-foreground/90">
          The MWG CRM API lets external applications read and modify CRM
          data. Generate an API key from{" "}
          <Link
            href="/admin/api-keys"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            /admin/api-keys
          </Link>{" "}
          (admin access required), then pass it as a Bearer token in the
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
            Authorization
          </code>
          header.
        </p>

        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <DocSection title="Authentication">
            <p>
              All requests require a Bearer token in the
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                Authorization
              </code>
              header.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed">
              <code>{`curl https://mwg-crm.vercel.app/v1/leads \\\n  -H "Authorization: Bearer mwg_live_..."`}</code>
            </pre>
            <p className="mt-3 text-sm text-muted-foreground">
              Keys are scoped per-environment. Treat them like passwords —
              never commit them to source control.
            </p>
          </DocSection>

          <DocSection title="Rate limits">
            <p>
              Default limit is{" "}
              <strong className="font-medium text-foreground">
                60 requests per minute, per key
              </strong>
              . Higher limits are configurable on each key. Every response
              carries the current state in headers:
            </p>
            <ul className="mt-3 space-y-1 font-mono text-xs">
              <li>
                <code>X-RateLimit-Limit</code>
              </li>
              <li>
                <code>X-RateLimit-Remaining</code>
              </li>
              <li>
                <code>X-RateLimit-Reset</code>
              </li>
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Exceeding the limit returns
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[0.85em]">
                429
              </code>
              with a
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[0.85em]">
                Retry-After
              </code>
              header indicating seconds to wait.
            </p>
          </DocSection>

          <DocSection title="Error format">
            <p>Errors return a canonical envelope:</p>
            <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed">
              <code>{`{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'email' is invalid.",
    "details": { "field": "email" }
  }
}`}</code>
            </pre>
            <p className="mt-3 text-sm text-muted-foreground">Codes:</p>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
              <li>
                <code>UNAUTHORIZED</code>
              </li>
              <li>
                <code>FORBIDDEN</code>
              </li>
              <li>
                <code>NOT_FOUND</code>
              </li>
              <li>
                <code>VALIDATION_ERROR</code>
              </li>
              <li>
                <code>RATE_LIMITED</code>
              </li>
              <li>
                <code>CONFLICT</code>
              </li>
              <li>
                <code>INTERNAL_ERROR</code>
              </li>
              <li>
                <code>KEY_REVOKED</code>
              </li>
              <li>
                <code>KEY_EXPIRED</code>
              </li>
            </ul>
          </DocSection>

          <DocSection title="Pagination">
            <p>
              Collection endpoints accept{" "}
              <code className="rounded bg-muted px-1 font-mono text-[0.85em]">
                ?page=N&pageSize=M
              </code>
              . Maximum
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[0.85em]">
                pageSize
              </code>
              is 200; default is 50.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed">
              <code>{`{
  "data": [ ... ],
  "meta": {
    "page": 1,
    "pageSize": 50,
    "total": 1287
  }
}`}</code>
            </pre>
          </DocSection>

          <DocSection title="Versioning">
            <p>
              Every endpoint is namespaced under{" "}
              <code className="rounded bg-muted px-1 font-mono text-[0.85em]">
                /v1
              </code>
              . We commit to{" "}
              <strong className="font-medium text-foreground">
                12 months notice
              </strong>{" "}
              before deprecating any /v1 endpoint. Breaking changes ship as{" "}
              <code className="rounded bg-muted px-1 font-mono text-[0.85em]">
                /v2
              </code>
              ; the old contract continues to work during the deprecation
              window.
            </p>
          </DocSection>

          <DocSection title="Contact">
            <p>
              Questions, key requests, or integration support:
              <br />
              <a
                href="mailto:crm-support@morganwhite.com"
                className="font-mono text-primary underline-offset-4 hover:underline"
              >
                crm-support@morganwhite.com
              </a>
            </p>
          </DocSection>
        </div>

        <hr className="mt-12 border-border" />
        <p className="mt-6 text-sm text-muted-foreground">
          The interactive reference below is generated from the live OpenAPI
          spec at{" "}
          <a
            href="/api/openapi.json"
            className="font-mono text-primary underline-offset-4 hover:underline"
          >
            /api/openapi.json
          </a>
          . Use the <em>Try it</em> panel on any operation — paste your own
          bearer token; we never store credentials in the page.
        </p>
      </section>

      {/* Scalar reference fills the remainder of the viewport. */}
      <section className="min-h-screen border-t border-border">
        <ApiReferenceReact
          configuration={{
            url: "/api/openapi.json",
            theme: "default",
            layout: "modern",
            hideClientButton: false,
            showSidebar: true,
            persistAuth: true,
            customCss: SCALAR_THEME_OVERRIDES,
            metaData: {
              title: "MWG CRM API Reference",
            },
          }}
        />
      </section>
    </main>
  );
}

function DocSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 backdrop-blur-sm">
      <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-foreground/85">
        {children}
      </div>
    </div>
  );
}
