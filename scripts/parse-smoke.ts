// Phase 6C — manual smoke runner for the activity parser.
// Not part of the test suite; run with: pnpm tsx scripts/parse-smoke.ts
//
// Pastes representative inputs through the parser and dumps the
// structured output. Useful when iterating on regex / format edge cases.

import {
  parseActivityColumn,
  parseAllActivityColumns,
} from "../src/lib/import/activity-parser";
import { detectD365 } from "../src/lib/import/d365-detect";
import { mapLeadStatus, mapOpportunityStage } from "../src/lib/import/stage-mapping";

function fmt(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`);
}

// 1. Single call with duration
fmt(
  "Call with duration",
  parseActivityColumn(
    `[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  Lead called wanting a family dental plan without copays.
  Quoted BrightSmile Elite. Enrollment must be online.`,
    "call",
  ),
);

// 2. Two calls in one cell, second is voicemail (no duration)
fmt(
  "Multi-call with voicemail",
  parseActivityColumn(
    `[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  Quoted BrightSmile Elite.

[2026-02-15 10:30 AM CT] Follow-up
  Outgoing | Left Voicemail | By: Tanzania Griffith`,
    "call",
  ),
);

// 3. Note inline form
fmt(
  "Note inline",
  parseActivityColumn(
    `[2020-04-21 09:15 AM CST] — by Rafael Somarriba initial inbound about group dental`,
    "note",
  ),
);

// 4. Meeting with attendees and duplicates
fmt(
  "Meeting with attendees",
  parseActivityColumn(
    `[2024-12-16 04:30 PM UTC] Renewal review
  Status: Completed | End: 2024-12-16 05:00 PM UTC | Duration: 30 min | Owner: Tanzania Griffith
  Attendees: Tanzania Griffith, Tanzania Griffith, Bettina Overbeck, Tanzania Griffith
  Reviewed renewal options.`,
    "meeting",
  ),
);

// 5. Email
fmt(
  "Email",
  parseActivityColumn(
    `[2026-01-30 11:00 AM EST] Quote sent
  From: tanzania.griffith@morganwhite.com | To: lead@example.com
  Attached BrightSmile Elite plan summary.`,
    "email",
  ),
);

// 6. Truncation
const synthetic = Array.from({ length: 250 })
  .map(
    (_, i) =>
      `[2024-${String((i % 12) + 1).padStart(2, "0")}-15 09:00 AM UTC] Synthetic ${i}\n  Outgoing | Duration: 5 min | By: Bot User\n  body ${i}`,
  )
  .join("\n\n");
fmt(
  "Truncation",
  (() => {
    const r = parseActivityColumn(synthetic, "call");
    return {
      activities: r.activities.length,
      warnings: r.warnings,
      first: r.activities[0]?.subject,
      last: r.activities[r.activities.length - 1]?.subject,
    };
  })(),
);

// 7. All four columns combined
fmt(
  "All-four combined",
  parseAllActivityColumns({
    phoneCalls: `[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  body`,
    notes: `[2020-04-21 09:15 AM CST] — by Rafael Somarriba initial inbound`,
    meetings: `[2024-12-16 04:30 PM UTC] Renewal
  Status: Completed | End: 2024-12-16 05:00 PM UTC | Duration: 30 min | Owner: Tanzania Griffith`,
    emails: undefined,
  }),
);

// 8. Smart-detect on a John-Costanzo style Description value
fmt(
  "Smart-detect: Snarky",
  detectD365(`Topic: Snarky

Linked Opportunity:
Name:        Snarky
Status:      In Progress
Probability: 10%
Owner:       Tanzania Griffith

Phone Calls:
[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  lead called wanting BEST dental plan w/o copays`),
);

// 9. Stage / status mapping
fmt("Stage map In Progress", mapOpportunityStage("In Progress"));
fmt("Stage map Won", mapOpportunityStage("Won"));
fmt("Stage map unknown", mapOpportunityStage("Pending"));
fmt("Status map Open", mapLeadStatus("Open"));
fmt("Status map Pending fallback", mapLeadStatus("Pending"));
