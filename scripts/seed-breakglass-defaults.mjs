// One-shot helper: create "All (test default)" saved views for the
// breakglass account across the 4 list pages that use saved-view defaults
// (leads, accounts, contacts, opportunities), and pin them as the
// account's default views. /tasks uses a text-backed
// lastUsedTaskViewId column that can hold the builtin id directly, so
// we set that to "builtin:open" as well.
//
// The breakglass account is admin (is_admin=true) but the leads page's
// fallback is `builtin:my-open` which scopes to owned rows — breakglass
// owns none, so the page renders empty. The Playwright smoke needs
// rows visible by default. Setting a scope:'all' saved view as the
// default flips the page to admin-wide visibility on plain page loads.
//
// Idempotent: re-running the script overwrites the existing view's
// filters/columns/scope and re-pins it. Safe to run multiple times.
//
// Usage:
//   pnpm dlx tsx --env-file .env.local scripts/seed-breakglass-defaults.mjs

import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL not set; pass --env-file .env.local");
  process.exit(1);
}

const client = postgres(url, {
  prepare: false,
  max: 1,
  ssl: "require",
  connection: { search_path: "public, extensions" },
});

const VIEW_NAME = "All (test default)";

async function ensureView(userId, entityType) {
  // Upsert by the unique (user_id, entity_type, name) constraint.
  // scope='all' bypasses the owner filter; empty filters/columns fall
  // back to entity defaults.
  const rows = await client`
    INSERT INTO saved_views
      (user_id, entity_type, name, scope, filters, columns)
    VALUES
      (${userId}, ${entityType}, ${VIEW_NAME}, 'all', '{}'::jsonb, '[]'::jsonb)
    ON CONFLICT (user_id, entity_type, name)
    DO UPDATE SET
      scope = 'all',
      filters = '{}'::jsonb,
      columns = '[]'::jsonb,
      updated_at = now(),
      version = saved_views.version + 1
    RETURNING id
  `;
  return rows[0].id;
}

try {
  const [bg] = await client`
    SELECT id FROM users WHERE is_breakglass = true LIMIT 1
  `;
  if (!bg) {
    console.error("No breakglass row found.");
    process.exitCode = 1;
  } else {
    const userId = bg.id;
    console.log(`Breakglass user: ${userId}`);

    const leadsViewId = await ensureView(userId, "lead");
    const accountsViewId = await ensureView(userId, "account");
    const contactsViewId = await ensureView(userId, "contact");
    const opportunitiesViewId = await ensureView(userId, "opportunity");

    await client`
      INSERT INTO user_preferences
        (user_id, default_leads_view_id, default_account_view_id,
         default_contact_view_id, default_opportunity_view_id,
         last_used_task_view_id)
      VALUES
        (${userId}, ${leadsViewId}, ${accountsViewId},
         ${contactsViewId}, ${opportunitiesViewId},
         'builtin:open')
      ON CONFLICT (user_id) DO UPDATE SET
        default_leads_view_id = EXCLUDED.default_leads_view_id,
        default_account_view_id = EXCLUDED.default_account_view_id,
        default_contact_view_id = EXCLUDED.default_contact_view_id,
        default_opportunity_view_id = EXCLUDED.default_opportunity_view_id,
        last_used_task_view_id = EXCLUDED.last_used_task_view_id
    `;
    console.log(`[ok] leads default      → ${leadsViewId}`);
    console.log(`[ok] accounts default   → ${accountsViewId}`);
    console.log(`[ok] contacts default   → ${contactsViewId}`);
    console.log(`[ok] opportunities def. → ${opportunitiesViewId}`);
    console.log(`[ok] tasks last-used    → builtin:open`);
  }
} catch (err) {
  console.error("Seed failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
