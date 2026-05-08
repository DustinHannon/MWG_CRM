# MWG CRM

Internal customer relationship management for Morgan White Group.
Production: https://mwg-crm.vercel.app

## What it is

A purpose-built CRM replacing ~30% of Dynamics 365 Sales features used by MWG.
Lead → Opportunity → Account workflow, with import from D365 exports, full activity
history, and Microsoft 365 integration via Entra ID + Graph.

## Tech stack

- Next.js 16 (App Router) + React 19 + Tailwind v4
- TypeScript (strict)
- Supabase Postgres + Drizzle ORM
- Auth.js v5 — Microsoft Entra ID (OIDC) + breakglass credentials fallback
- Vercel hosting; Vercel Blob for attachments
- shadcn/ui + Radix + lucide-react + sonner

## Local development

```bash
pnpm install
cp .env.example .env.local
# Fill in MWG-specific values per .env.example comments
pnpm dev
```

Open http://localhost:3000.

## Deployment

Push to `master` → Vercel auto-deploys to production. Database migrations apply via
Supabase MCP `apply_migration` from a Claude Code session.

## Documentation

- [Architecture](docs/architecture/ARCHITECTURE.md) — system design, data model, auth flow, cron stack
- [Security notes](docs/architecture/SECURITY-NOTES.md) — posture, accepted risks, IDOR / CSP / secrets
- [Theme audit](docs/architecture/THEME-AUDIT.md) — UI conformance reference
- [Roadmap](ROADMAP.md) — next-up features and deferred items
- [Phase history](docs/phases/) — plans and audit reports from each build phase

## Conventions for future phase work

When a Claude Code phase produces working notes, plans, or audit reports, write them
directly into `docs/phases/plans/` or `docs/phases/reports/` — NOT the repo root.
The root is gitignored against `PHASE*.md` and `PLAN-PHASE*.md` patterns to keep
itself clean.
