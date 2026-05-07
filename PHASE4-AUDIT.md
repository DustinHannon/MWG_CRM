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
