// Pure heuristics — safe for any context. No `server-only` directive.
// Used by mappers (server-side) and could be used client-side for
// preview if a future feature needs it.

/**
 * bad-lead quality heuristics.
 *
 * MWG's D365 instance carries years of accumulated junk from prior
 * bad imports — empty rows, test-pattern emails (`asdf@asdf.com`),
 * leads with literally one character in the name, etc. We don't
 * want any of that landing in the new CRM.
 *
 * Three verdicts:
 * `clean` — commit normally.
 * `suspicious` — has 1-2 quality issues but enough real data to
 * keep. Commits with a non-fatal warning surfaced
 * in the review UI.
 * `garbage` — clearly bad. map-batch auto-skips these
 * (status='skipped'), writes an audit row with
 * the reasons array, and increments the batch's
 * skipped counter. Reviewer can override
 * record in the review UI.
 *
 * If > 50% of a batch verdicts as garbage, the run halts with reason
 * `bad_lead_volume` for human review — that's almost certainly a
 * known-bad import era that deserves admin attention before any
 * silent-skip pattern locks in.
 */

export type QualityVerdict = "clean" | "suspicious" | "garbage";

export interface QualityAssessment {
  verdict: QualityVerdict;
  reasons: string[];
}

export interface LeadQualityInput {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  companyName: string | null | undefined;
  email: string | null | undefined;
  phone: string | null | undefined;
  mobilePhone?: string | null | undefined;
  jobTitle?: string | null | undefined;
  description?: string | null | undefined;
  subject?: string | null | undefined;
  industry?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Email garbage patterns
// ---------------------------------------------------------------------------

/** Local-part patterns that are clearly placeholders / test data. */
const GARBAGE_LOCAL_PARTS: readonly RegExp[] = [
  /^test\d*$/i,
  /^testing\d*$/i,
  /^asdf+\d*$/i,
  /^qwerty+\d*$/i,
  /^abc+\d*$/i,
  /^xxx+\d*$/i,
  /^null$/i,
  /^none$/i,
  /^noemail$/i,
  /^nomail$/i,
  /^noreply$/i,
  /^no-reply$/i,
  /^donotreply$/i,
  /^do-not-reply$/i,
  /^nobody$/i,
  /^unknown$/i,
  /^temp$/i,
  /^placeholder$/i,
  /^example$/i,
  /^anonymous$/i,
  /^user$/i,
  /^demo$/i,
  /^fake$/i,
  /^[a-z]$/i, // single letter
  /^(.)\1{3,}$/, // 4+ of the same character: aaaa, 1111, ....
  /^\d{1,5}$/, // pure numeric local part up to 5 digits
];

/** Domain patterns that are clearly placeholders / test data. */
const GARBAGE_DOMAINS: readonly RegExp[] = [
  /^example\./i,
  /^test\./i,
  /^localhost$/i,
  /\.test$/i,
  /\.localhost$/i,
  /\.invalid$/i,
  /^none\./i,
  /^null\./i,
  /^domain\.com$/i,
  /^email\.com$/i,
  /^xxx\./i,
  /^abc\./i,
  /^123\./i,
];

/** Strings used as placeholders in name/company fields. */
const PLACEHOLDER_NAME_PATTERNS: readonly RegExp[] = [
  /^unknown$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^null$/i,
  /^test+$/i,
  /^tbd$/i,
  /^xxx+$/i,
  /^asdf+$/i,
  /^abc+$/i,
  /^qwerty+$/i,
  /^placeholder$/i,
  /^anonymous$/i,
  /^nobody$/i,
  /^fake$/i,
  /^demo$/i,
  /^delete$/i,
  /^remove$/i,
  /^[\W_]+$/, // only punctuation/whitespace
  /^(.)\1{2,}$/, // 3+ of the same character
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlank(s: string | null | undefined): boolean {
  return s == null || String(s).trim().length === 0;
}

function looksLikePlaceholder(s: string | null | undefined): boolean {
  if (isBlank(s)) return false;
  const trimmed = String(s).trim();
  return PLACEHOLDER_NAME_PATTERNS.some((re) => re.test(trimmed));
}

interface EmailParts {
  local: string;
  domain: string;
}

function parseEmail(email: string | null | undefined): EmailParts | null {
  if (isBlank(email)) return null;
  const at = email!.lastIndexOf("@");
  if (at <= 0 || at === email!.length - 1) return null;
  return {
    local: email!.slice(0, at).trim(),
    domain: email!.slice(at + 1).trim().toLowerCase(),
  };
}

/** True if the email syntactically parses but is clearly garbage. */
function isGarbageEmail(email: string | null | undefined): boolean {
  const parts = parseEmail(email);
  if (!parts) return false;
  if (GARBAGE_LOCAL_PARTS.some((re) => re.test(parts.local))) return true;
  if (GARBAGE_DOMAINS.some((re) => re.test(parts.domain))) return true;
  return false;
}

/** True if the email is structurally invalid. */
function isMalformedEmail(email: string | null | undefined): boolean {
  if (isBlank(email)) return false;
  const parts = parseEmail(email);
  if (!parts) return true;
  // Bare-minimum structural check: domain must contain a dot.
  if (!parts.domain.includes(".")) return true;
  // No whitespace allowed inside the value.
  if (/\s/.test(email!)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Lead-level assessment
// ---------------------------------------------------------------------------

/**
 * Score a mapped lead's data quality. Pure function — no DB calls.
 *
 * Garbage triggers (any one is enough):
 * All identity fields blank: no first/last/company AND no email AND
 * no phone.
 * Email matches a garbage pattern AND no real name OR company.
 * Both first and last name are placeholders ("test", "asdf", etc.)
 * AND email is garbage or missing.
 *
 * Suspicious triggers (commit, but flag):
 * Email is malformed (parses but no `.` in domain, etc.).
 * Name field is a single character or matches a placeholder
 * pattern.
 * Has email but no other identifying field at all.
 * Has only a company name and nothing else (no contact info).
 */
export function assessLeadQuality(input: LeadQualityInput): QualityAssessment {
  const reasons: string[] = [];

  const hasFirst = !isBlank(input.firstName);
  const hasLast = !isBlank(input.lastName);
  const hasCompany = !isBlank(input.companyName);
  const hasEmail = !isBlank(input.email);
  const hasPhone = !isBlank(input.phone) || !isBlank(input.mobilePhone);
  const hasJob = !isBlank(input.jobTitle);
  const hasDesc =
    !isBlank(input.description) || !isBlank(input.subject);
  const hasAddress = !isBlank(input.city) || !isBlank(input.state);
  const hasIndustry = !isBlank(input.industry);

  const garbageEmail = isGarbageEmail(input.email);
  const malformedEmail = isMalformedEmail(input.email);

  const firstIsPlaceholder = looksLikePlaceholder(input.firstName);
  const lastIsPlaceholder = looksLikePlaceholder(input.lastName);
  const companyIsPlaceholder = looksLikePlaceholder(input.companyName);

  // ---------- garbage triggers ----------
  if (!hasFirst && !hasLast && !hasCompany && !hasEmail && !hasPhone) {
    reasons.push("empty: no name, company, email, or phone");
    return { verdict: "garbage", reasons };
  }

  if (garbageEmail && !hasFirst && !hasLast && !hasCompany) {
    reasons.push(
      `garbage email '${input.email}' with no real name or company`,
    );
    return { verdict: "garbage", reasons };
  }

  if (
    (firstIsPlaceholder || !hasFirst) &&
    (lastIsPlaceholder || !hasLast) &&
    (companyIsPlaceholder || !hasCompany) &&
    (!hasEmail || garbageEmail)
  ) {
    reasons.push(
      "all name/company fields are placeholders or blank, email is missing or garbage",
    );
    return { verdict: "garbage", reasons };
  }

  if (firstIsPlaceholder && lastIsPlaceholder && (!hasEmail || garbageEmail)) {
    reasons.push(
      `name fields are placeholders ('${input.firstName}' / '${input.lastName}') with no usable email`,
    );
    return { verdict: "garbage", reasons };
  }

  // ---------- suspicious triggers ----------
  if (malformedEmail) {
    reasons.push(`malformed email '${input.email}'`);
  }
  if (garbageEmail) {
    reasons.push(`garbage email pattern '${input.email}'`);
  }
  if (firstIsPlaceholder) {
    reasons.push(`first name placeholder '${input.firstName}'`);
  }
  if (lastIsPlaceholder) {
    reasons.push(`last name placeholder '${input.lastName}'`);
  }
  if (companyIsPlaceholder) {
    reasons.push(`company name placeholder '${input.companyName}'`);
  }
  // Single character name fields.
  if (
    !isBlank(input.firstName) &&
    String(input.firstName).trim().length === 1
  ) {
    reasons.push(`first name is a single character '${input.firstName}'`);
  }
  if (
    !isBlank(input.lastName) &&
    String(input.lastName).trim().length === 1
  ) {
    reasons.push(`last name is a single character '${input.lastName}'`);
  }
  // Email + no other identifying fields beyond garbage.
  if (
    hasEmail &&
    !hasFirst &&
    !hasLast &&
    !hasCompany &&
    !hasPhone &&
    !hasJob &&
    !hasDesc &&
    !hasAddress &&
    !hasIndustry
  ) {
    reasons.push("email-only record with no other identifying fields");
  }
  // Company-only record with no contact info at all.
  if (hasCompany && !hasFirst && !hasLast && !hasEmail && !hasPhone) {
    reasons.push("company-only record with no contact info");
  }

  if (reasons.length > 0) return { verdict: "suspicious", reasons };
  return { verdict: "clean", reasons: [] };
}

// ---------------------------------------------------------------------------
// Batch-level halt threshold
// ---------------------------------------------------------------------------

/**
 * Compute the batch-level garbage rate. Used by map-batch to decide
 * whether to halt with `bad_lead_volume` reason. Threshold is 50% —
 * anything past that is almost certainly a known-bad import era and
 * deserves explicit admin review before silent-skip locks in.
 */
export function shouldHaltOnGarbageVolume(
  garbageCount: number,
  totalCount: number,
  thresholdRatio = 0.5,
): boolean {
  if (totalCount === 0) return false;
  return garbageCount / totalCount > thresholdRatio;
}
