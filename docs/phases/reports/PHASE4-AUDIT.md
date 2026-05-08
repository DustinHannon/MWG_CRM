# PHASE4-AUDIT.md — running audit log

## §2.1 Static audit (2026-05-07)

### `pnpm audit --prod`
| Package | Severity | Action |
|---|---|---|
| `xlsx@0.18.5` | 2× HIGH (Prototype Pollution + ReDoS) | **Accepted.** No npm patch. Already documented in `SECURITY-NOTES.md` Phase 2B. Mitigations: `import "server-only"`, admins-only upload, 10 MB cap, magic-byte validation (added in 4A.3), and `failed_rows` cap (added in 4A.3). |
| `postcss<8.5.10` | MODERATE (XSS via unescaped `</style>`) | **Resolved.** Added `pnpm.overrides` pin: `"postcss@<8.5.10": "^8.5.14"`. Now resolves to single 8.5.14 across the tree. Build verified green. |

Final state: **2 HIGH (xlsx, accepted)** + **0 MODERATE**.

### `pnpm tsc --noEmit`
Clean. Zero errors.

### `pnpm lint`
Clean. Zero errors. Zero warnings.

### Dead-code scan (manual)
Walked exports in `src/lib/` against import call-sites. No unused exports found at the lib boundary. Internal helpers self-contained.

### Build (`pnpm build`)
Green. All 32 routes compile. Middleware compiles. No type / lint blockers.

---

## §2.2 DB integrity audit
*(in progress)*

## §2.3 Validation primitives + CHECK constraints
*(in progress)*

## §2.4 Security pass
*(in progress)*

## §2.5 Structured logger
*(in progress)*

## §2.6 Try/catch coverage
*(in progress)*

## §2.7 Optimistic concurrency
*(in progress)*

## §2.8 Documentation
*(in progress)*

## §2.9 Smoke-test
*(in progress)*

---

## Final smoke test (2026-05-07 11:55 CDT)

| Check | Result |
|---|---|
| `pnpm tsc --noEmit` | clean |
| `pnpm lint` | clean (zero warnings) |
| `pnpm build` | clean — 36 routes including new `/leads/archived`, `/leads/print/[id]`, `/api/cron/rescore-leads`, `/api/cron/purge-archived` |
| `pnpm audit --prod` | 2 HIGH (`xlsx` accepted-risk per SECURITY-NOTES) — moderate `postcss` resolved via override |
| Orphan scan | zero across 16 parent/child relationships |
| CHECK rejects `email = 'not-an-email'` | confirmed via DO-block test |
| Supabase `get_advisors security` | zero ERRORS (down from 7); 23 INFO-level rls_enabled_no_policy (intentional BYPASSRLS pattern); 2 WARN extension_in_public for pg_trgm/unaccent (cosmetic) |
| Vercel deployment | latest commit `eddc2e2` deploying; previous commit `c986530` (4G+4C+4H) verified READY in production |

## Phase 4 deliverables shipped

- **4A** Static audit · DB integrity · validation primitives + CHECK · security gates · structured logger · `withErrorBoundary` · OCC stamps · documentation (`ARCHITECTURE.md`, `SECURITY-NOTES.md`).
- **4B** View auto-revert backend.
- **4C** Lead scoring engine + nightly cron + badge component (admin UI deferred).
- **4E** Bulk-tag server action (toolbar UI deferred).
- **4F** Print / Save-as-PDF route + button.
- **4G** Soft delete + archive view + purge cron.
- **4H** Full-text search rewrite of Cmd+K.

## Phase 4 deliverables deferred (see ROADMAP.md)

- 4D Forecasting dashboard.
- 4I Mobile responsiveness pass.
- 4J Manager → CRM user linking.
- 4B column drag-and-drop reorder UI.
- 4E bulk-tag selection toolbar UI.
- 4C `/admin/scoring` rule-builder UI.
- OCC UI conflict banners on lead-detail / opportunity-edit forms.
