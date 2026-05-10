"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Mail,
  Send,
  Users,
} from "lucide-react";
import { SafeHtmlPreview } from "@/components/security/safe-html-preview";
import {
  createCampaignDraftAction,
  scheduleCampaignAction,
  sendCampaignNowAction,
  updateCampaignDraftAction,
} from "../../actions";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface WizardTemplate {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  renderedHtml: string;
  updatedAt: Date;
}

export interface WizardList {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  lastRefreshedAt: Date | null;
}

export interface ExistingDraft {
  id: string;
  name: string;
  templateId: string;
  listId: string;
  fromEmail: string;
  fromName: string;
  replyToEmail: string | null;
  scheduledFor: string | null;
  status: string;
}

interface CampaignWizardProps {
  templates: WizardTemplate[];
  lists: WizardList[];
  existing: ExistingDraft | null;
  defaultListId: string | null;
  defaultTemplateId: string | null;
  defaultFromEmail: string;
  defaultFromName: string;
}

type Step = 1 | 2 | 3 | 4;
type ScheduleMode = "now" | "later";

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function CampaignWizard({
  templates,
  lists,
  existing,
  defaultListId,
  defaultTemplateId,
  defaultFromEmail,
  defaultFromName,
}: CampaignWizardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pick the most logical starting step based on what's already
  // populated.
  const initialStep = computeInitialStep(existing);
  const [step, setStep] = useState<Step>(initialStep);
  const [campaignId, setCampaignId] = useState<string | null>(
    existing?.id ?? null,
  );

  // Step 1 — template
  const [templateId, setTemplateId] = useState<string | null>(
    existing?.templateId ?? defaultTemplateId,
  );
  const [templateSearch, setTemplateSearch] = useState("");

  // Step 2 — list
  const [listId, setListId] = useState<string | null>(
    existing?.listId ?? defaultListId,
  );

  // Step 3 — schedule
  const [name, setName] = useState(existing?.name ?? "");
  const [fromEmail, setFromEmail] = useState(
    existing?.fromEmail ?? defaultFromEmail,
  );
  const [fromName, setFromName] = useState(
    existing?.fromName ?? defaultFromName,
  );
  const [replyToEmail, setReplyToEmail] = useState(
    existing?.replyToEmail ?? "",
  );
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    existing?.scheduledFor ? "later" : "now",
  );
  const [scheduledFor, setScheduledFor] = useState(
    existing?.scheduledFor
      ? toLocalDatetimeInputValue(new Date(existing.scheduledFor))
      : "",
  );

  /* --------------------------------------------------------------- */
  /* Derived                                                          */
  /* --------------------------------------------------------------- */

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.subject.toLowerCase().includes(q),
    );
  }, [templates, templateSearch]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templateId, templates],
  );
  const selectedList = useMemo(
    () => lists.find((l) => l.id === listId) ?? null,
    [listId, lists],
  );

  /* --------------------------------------------------------------- */
  /* Actions                                                          */
  /* --------------------------------------------------------------- */

  function persistDraftAndAdvance(target: Step) {
    setError(null);
    startTransition(async () => {
      // Step 1 → 2: create or update draft with chosen templateId.
      if (step === 1 && templateId && listId) {
        // Special case: first save with both required FKs known. We
        // need a list id to satisfy NOT NULL. If the user hasn't
        // touched lists yet but a `?listId=` was seeded, we'll have
        // it; otherwise we defer creation until step 2.
        if (!campaignId) {
          const res = await createCampaignDraftAction({
            templateId,
            listId,
            name: deriveDefaultName({ template: selectedTemplate }),
          });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setCampaignId(res.data.id);
          // Reflect in URL so refresh resumes.
          router.replace(`/marketing/campaigns/new?id=${res.data.id}`);
        } else {
          const res = await updateCampaignDraftAction({
            id: campaignId,
            templateId,
          });
          if (!res.ok) {
            setError(res.error);
            return;
          }
        }
      }

      if (step === 1 && templateId && !listId) {
        // We can't persist yet without a list. Just advance — step 2
        // will create/update.
      }

      // Step 2: list picked. Either create the draft now (if step 1
      // hadn't done it because no listId) or update it.
      if (step === 2 && templateId && listId) {
        if (!campaignId) {
          const res = await createCampaignDraftAction({
            templateId,
            listId,
            name: deriveDefaultName({ template: selectedTemplate }),
          });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setCampaignId(res.data.id);
          router.replace(`/marketing/campaigns/new?id=${res.data.id}`);
        } else {
          const res = await updateCampaignDraftAction({
            id: campaignId,
            listId,
          });
          if (!res.ok) {
            setError(res.error);
            return;
          }
        }
      }

      // Step 3: schedule fields. Persist all editable identity fields.
      if (step === 3 && campaignId) {
        const res = await updateCampaignDraftAction({
          id: campaignId,
          name: name.trim() || deriveDefaultName({ template: selectedTemplate }),
          fromEmail,
          fromName,
          replyToEmail: replyToEmail.trim() || "",
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }

      setStep(target);
    });
  }

  function handleConfirmSendOrSchedule() {
    if (!campaignId) return;
    setError(null);
    startTransition(async () => {
      if (scheduleMode === "later") {
        if (!scheduledFor) {
          setError("Pick a date and time first.");
          return;
        }
        const at = new Date(scheduledFor);
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
          setError("Schedule time must be in the future.");
          return;
        }
        const res = await scheduleCampaignAction({
          id: campaignId,
          scheduledFor: at,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
      } else {
        const res = await sendCampaignNowAction(campaignId);
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      router.push(`/marketing/campaigns/${campaignId}`);
    });
  }

  /* --------------------------------------------------------------- */
  /* Render                                                           */
  /* --------------------------------------------------------------- */

  return (
    <div className="flex flex-col gap-6">
      <Stepper current={step} />

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-4 py-3 text-sm text-[var(--status-lost-fg)]"
        >
          {error}
        </div>
      ) : null}

      {step === 1 ? (
        <StepTemplate
          templates={filteredTemplates}
          search={templateSearch}
          onSearch={setTemplateSearch}
          selectedId={templateId}
          onSelect={setTemplateId}
        />
      ) : null}

      {step === 2 ? (
        <StepList
          lists={lists}
          selectedId={listId}
          onSelect={setListId}
        />
      ) : null}

      {step === 3 ? (
        <StepSchedule
          name={name}
          onName={setName}
          fromEmail={fromEmail}
          onFromEmail={setFromEmail}
          fromName={fromName}
          onFromName={setFromName}
          replyToEmail={replyToEmail}
          onReplyToEmail={setReplyToEmail}
          scheduleMode={scheduleMode}
          onScheduleMode={setScheduleMode}
          scheduledFor={scheduledFor}
          onScheduledFor={setScheduledFor}
        />
      ) : null}

      {step === 4 ? (
        <StepReview
          template={selectedTemplate}
          list={selectedList}
          name={name || deriveDefaultName({ template: selectedTemplate })}
          fromEmail={fromEmail}
          fromName={fromName}
          replyToEmail={replyToEmail}
          scheduleMode={scheduleMode}
          scheduledFor={scheduledFor}
        />
      ) : null}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <button
          type="button"
          disabled={step === 1 || pending}
          onClick={() => setStep((s) => (Math.max(1, s - 1) as Step))}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </button>

        {step < 4 ? (
          <button
            type="button"
            disabled={pending || !canAdvance({ step, templateId, listId })}
            onClick={() => persistDraftAndAdvance((step + 1) as Step)}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Continue"}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || !campaignId}
            onClick={handleConfirmSendOrSchedule}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? (
              "Working…"
            ) : scheduleMode === "later" ? (
              <>
                <Clock className="h-4 w-4" aria-hidden /> Schedule send
              </>
            ) : (
              <>
                <Send className="h-4 w-4" aria-hidden /> Send now
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function Stepper({ current }: { current: Step }) {
  const items: { step: Step; label: string; icon: React.ReactNode }[] = [
    { step: 1, label: "Template", icon: <Mail className="h-4 w-4" /> },
    { step: 2, label: "List", icon: <Users className="h-4 w-4" /> },
    { step: 3, label: "Schedule", icon: <Clock className="h-4 w-4" /> },
    { step: 4, label: "Review", icon: <Check className="h-4 w-4" /> },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {items.map((item, i) => {
        const done = current > item.step;
        const active = current === item.step;
        return (
          <li key={item.step} className="flex items-center gap-2">
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 transition " +
                (active
                  ? "border-foreground bg-foreground text-background"
                  : done
                    ? "border-[var(--status-qualified-fg)]/30 bg-[var(--status-qualified-bg)] text-[var(--status-qualified-fg)]"
                    : "border-border bg-muted text-muted-foreground")
              }
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : item.icon}
              <span className="font-medium">
                {item.step}. {item.label}
              </span>
            </span>
            {i < items.length - 1 ? (
              <span aria-hidden className="text-muted-foreground/40">
                /
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepTemplate({
  templates,
  search,
  onSearch,
  selectedId,
  onSelect,
}: {
  templates: WizardTemplate[];
  search: string;
  onSearch: (v: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">
          1. Pick a template
        </h2>
        <input
          type="search"
          placeholder="Search templates…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-64 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">
          No ready templates yet. Build one in the Templates tab and mark it
          ready.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => {
            const selected = t.id === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelect(t.id)}
                aria-pressed={selected}
                className={
                  "flex flex-col gap-3 rounded-2xl border p-4 text-left transition " +
                  (selected
                    ? "border-foreground bg-muted/60 ring-2 ring-ring/40"
                    : "border-border bg-muted/40 hover:bg-muted")
                }
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Subject: {t.subject}
                  </p>
                </div>
                <div className="h-[180px] overflow-hidden rounded-lg border border-border">
                  <SafeHtmlPreview
                    html={t.renderedHtml}
                    title={`${t.name} preview`}
                    className="h-full w-full bg-white"
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StepList({
  lists,
  selectedId,
  onSelect,
}: {
  lists: WizardList[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-foreground">
        2. Pick the audience
      </h2>
      {lists.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">
          No marketing lists yet. Build one in the Lists tab.
        </div>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {lists.map((l) => {
            const selected = l.id === selectedId;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onSelect(l.id)}
                  aria-pressed={selected}
                  className={
                    "flex w-full flex-col gap-1 rounded-2xl border p-4 text-left transition " +
                    (selected
                      ? "border-foreground bg-muted/60 ring-2 ring-ring/40"
                      : "border-border bg-muted/40 hover:bg-muted")
                  }
                >
                  <p className="text-sm font-medium text-foreground">{l.name}</p>
                  {l.description ? (
                    <p className="text-xs text-muted-foreground">
                      {l.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {l.memberCount.toLocaleString()} member
                    {l.memberCount === 1 ? "" : "s"}
                    {l.lastRefreshedAt ? (
                      <span className="text-muted-foreground/70">
                        {" · refreshed "}
                        {l.lastRefreshedAt.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/70">
                        {" · never refreshed"}
                      </span>
                    )}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StepSchedule({
  name,
  onName,
  fromEmail,
  onFromEmail,
  fromName,
  onFromName,
  replyToEmail,
  onReplyToEmail,
  scheduleMode,
  onScheduleMode,
  scheduledFor,
  onScheduledFor,
}: {
  name: string;
  onName: (v: string) => void;
  fromEmail: string;
  onFromEmail: (v: string) => void;
  fromName: string;
  onFromName: (v: string) => void;
  replyToEmail: string;
  onReplyToEmail: (v: string) => void;
  scheduleMode: ScheduleMode;
  onScheduleMode: (v: ScheduleMode) => void;
  scheduledFor: string;
  onScheduledFor: (v: string) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-foreground">
        3. Identity &amp; schedule
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Campaign name">
          <input
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Q2 newsletter"
            className="w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="From email">
          <input
            type="email"
            value={fromEmail}
            onChange={(e) => onFromEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="From name">
          <input
            type="text"
            value={fromName}
            onChange={(e) => onFromName(e.target.value)}
            className="w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="Reply-to (optional)">
          <input
            type="email"
            value={replyToEmail}
            onChange={(e) => onReplyToEmail(e.target.value)}
            placeholder="reply@morganwhite.com"
            className="w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
      </div>

      <div className="rounded-2xl border border-border bg-muted/40 p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Send timing
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="schedule-mode"
              value="now"
              checked={scheduleMode === "now"}
              onChange={() => onScheduleMode("now")}
            />
            Send now (on submit)
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="schedule-mode"
              value="later"
              checked={scheduleMode === "later"}
              onChange={() => onScheduleMode("later")}
            />
            Schedule for a specific time
          </label>
          {scheduleMode === "later" ? (
            <div className="ml-6 mt-1 flex items-center gap-2">
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => onScheduledFor(e.target.value)}
                className="rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <span className="text-xs text-muted-foreground">
                Times entered in your browser&apos;s local timezone.
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StepReview({
  template,
  list,
  name,
  fromEmail,
  fromName,
  replyToEmail,
  scheduleMode,
  scheduledFor,
}: {
  template: WizardTemplate | null;
  list: WizardList | null;
  name: string;
  fromEmail: string;
  fromName: string;
  replyToEmail: string;
  scheduleMode: ScheduleMode;
  scheduledFor: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-foreground">
        4. Review &amp; confirm
      </h2>
      <dl className="grid gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm md:grid-cols-2">
        <ReviewRow label="Campaign name" value={name} />
        <ReviewRow label="Template" value={template?.name ?? "—"} />
        <ReviewRow label="Subject" value={template?.subject ?? "—"} />
        <ReviewRow
          label="Audience"
          value={
            list
              ? `${list.name} (${list.memberCount.toLocaleString()} members)`
              : "—"
          }
        />
        <ReviewRow label="From" value={`${fromName} <${fromEmail}>`} />
        <ReviewRow label="Reply-to" value={replyToEmail || "(none)"} />
        <ReviewRow
          label="Send timing"
          value={
            scheduleMode === "now"
              ? "Send now (on submit)"
              : `Scheduled for ${scheduledFor || "(not picked)"}`
          }
        />
      </dl>
      {template ? (
        <div className="rounded-2xl border border-border bg-card p-2">
          <p className="px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground">
            Email preview
          </p>
          <div className="h-[480px] overflow-hidden rounded-lg border border-border">
            <SafeHtmlPreview
              html={template.renderedHtml}
              title={`${template.name} preview`}
              className="h-full w-full bg-white"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <div>{children}</div>
    </label>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-foreground/90">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeInitialStep(existing: ExistingDraft | null): Step {
  if (!existing) return 1;
  // Resume on review if everything's set; otherwise on schedule.
  if (existing.scheduledFor) return 4;
  return 3;
}

function canAdvance({
  step,
  templateId,
  listId,
}: {
  step: Step;
  templateId: string | null;
  listId: string | null;
}): boolean {
  if (step === 1) return Boolean(templateId);
  if (step === 2) return Boolean(listId);
  if (step === 3) return true;
  return true;
}

function deriveDefaultName({
  template,
}: {
  template: WizardTemplate | null;
}): string {
  if (template) {
    return `${template.name} — ${new Date().toISOString().slice(0, 10)}`;
  }
  return `Campaign — ${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Render a Date as the value `<input type="datetime-local">` expects:
 * `YYYY-MM-DDTHH:mm` in the local timezone.
 */
function toLocalDatetimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
