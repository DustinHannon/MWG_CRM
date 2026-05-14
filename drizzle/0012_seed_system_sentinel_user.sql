-- Aligns the pre-existing sentinel service-account user to the
-- canonical system@morganwhite.com email. Row was created on 2026-05-08
-- with email system@mwg.local; rename via UPDATE to match the email
-- domain we use everywhere else. Idempotent — no-op if already migrated.
--
-- This row is the fallback actor FK for system-initiated audit and log
-- writes that don't have a real human actor: cron self-audits via
-- writeSystemAudit, and the marketing failure-logger fallback when the
-- prior admin-by-from-email-domain lookup misses.
--
-- F-α-24 (b) from the email-review-sub-α findings file. Replaces the
-- prior "drop the log write on FK miss" branch in logMarketingSendFailure
-- so admin-visible failure rows are never silently lost.
UPDATE users
SET email = 'system@morganwhite.com'
WHERE id = '3aa151da-b500-4463-bccf-2fc3f6c5ef18'::uuid
  AND email = 'system@mwg.local';
