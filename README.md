# MWG CRM

Internal customer relationship management for Morgan White Group.
Production: <https://crm.morganwhite.com>

## What it is

A purpose-built CRM that replaces the slice of Dynamics 365 Sales the team
actually used. Lead → Opportunity → Account workflow with full activity
history, Microsoft 365 integration via Entra SSO + Graph (mail, calendar,
profile photos), and a public REST API for outside integrations.

## Surfaces

- **Web app** — leads, accounts, contacts, opportunities, tasks, activities,
  saved views, reports, mobile-responsive shell.
- **Admin** — users, permissions, tags, lead scoring rules, audit log,
  data tools, API keys, API usage log.
- **Public API** — `/api/v1/*` Bearer-token REST surface for programmatic
  access. Per-key scopes, rate limits, expirations. Reference at
  <https://crm.morganwhite.com/apihelp>.

## Tech stack

- Next.js 16 (App Router) + React 19 + Tailwind v4
- TypeScript (strict)
- Supabase Postgres + Drizzle ORM
- Auth.js v5 — Microsoft Entra ID (OIDC) + breakglass credentials fallback
- Vercel hosting; Vercel Blob for attachments; Supabase Realtime for live updates
- shadcn/ui + Radix + lucide-react + sonner
- Scalar + zod-to-openapi for the public API reference

## Deployment

Push to `master` → Vercel auto-deploys. Database migrations apply through
Supabase MCP from a Claude Code session; the live schema is the source of
truth.

## License

Proprietary. Internal use by Morgan White Group only.
