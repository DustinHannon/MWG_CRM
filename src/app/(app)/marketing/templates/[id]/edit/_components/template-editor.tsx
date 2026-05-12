"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { LockedTemplateBanner } from "@/components/marketing/locked-template-banner";
import { UnlayerEditor } from "@/components/marketing/unlayer-editor";
import { useTemplateLock } from "@/hooks/marketing/use-template-lock";
import {
  archiveTemplateAction,
  changeTemplateScopeAction,
  sendTestTemplateAction,
  updateTemplateAction,
} from "../../../actions";

type TemplateStatus = "draft" | "ready" | "archived";
type TemplateScope = "global" | "personal";

interface InitialHolder {
  userId: string;
  userName: string;
  acquiredAt: string;
}

interface TemplateEditorProps {
  templateId: string;
  initialName: string;
  initialSubject: string;
  initialPreheader: string;
  initialDescription: string;
  // Drizzle returns `jsonb` columns as `unknown`. The Unlayer editor
  // expects an opaque object; we narrow at the mount call below and
  // skip `loadDesign` when the column is empty/null.
  initialDesign: unknown;
  initialStatus: TemplateStatus;
  /** current visibility for the inline scope toggle. */
  initialScope: TemplateScope;
  /** OCC version for the scope-change action. */
  initialVersion: number;
  /** only the creator can change scope. */
  isCreator: boolean;
  /** global→personal demote needs this on top of creator. */
  canMarketingTemplatesEdit: boolean;
  currentUserEmail: string;
  unlayerProjectId: number | null;
  unlayerConfigured: boolean;
  isAdmin: boolean;
  initialLockedHolder: InitialHolder | null;
}

/**
 * Template editor client. Owns the metadata form, mounts
 * the Unlayer canvas, runs the soft-lock heartbeat, and routes the
 * Save / Send-test / Archive actions through the server actions in
 * `../actions.ts`.
 */
export function TemplateEditor(props: TemplateEditorProps) {
  const router = useRouter();
  const lock = useTemplateLock(props.templateId);

  const [name, setName] = useState(props.initialName);
  const [subject, setSubject] = useState(props.initialSubject);
  const [preheader, setPreheader] = useState(props.initialPreheader);
  const [description, setDescription] = useState(props.initialDescription);
  const [status, setStatus] = useState<TemplateStatus>(props.initialStatus);
  // visibility radio state. `currentScope` is
  // what's persisted; `pendingScope` is what the user has selected
  // but not yet saved via the "Save visibility" button.
  const [currentScope, setCurrentScope] = useState<TemplateScope>(
    props.initialScope,
  );
  const [pendingScope, setPendingScope] = useState<TemplateScope>(
    props.initialScope,
  );
  const [scopeVersion, setScopeVersion] = useState(props.initialVersion);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [savePending, startSaveTransition] = useTransition();
  const [archivePending, startArchiveTransition] = useTransition();
  const [testPending, startTestTransition] = useTransition();
  const [scopePending, startScopeTransition] = useTransition();

  const [testOpen, setTestOpen] = useState(false);
  const [testRecipient, setTestRecipient] = useState(props.currentUserEmail);

  // SSR-rendered "another editor" holder takes precedence over the
  // hook's status until the hook has actually contacted the server
  // (it begins in 'acquiring').
  const initialHolder = props.initialLockedHolder
    ? {
        userId: props.initialLockedHolder.userId,
        userName: props.initialLockedHolder.userName,
        acquiredAt: new Date(props.initialLockedHolder.acquiredAt),
      }
    : null;

  const showInitialBanner = initialHolder !== null && lock.status !== "held";
  const showLockBanner =
    !showInitialBanner && lock.status === "locked" && lock.holder !== null;

  const handleForceUnlock = useCallback(async () => {
    const res = await fetch(
      `/api/v1/marketing/templates/${props.templateId}/lock/force`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(body?.error ?? "Failed to force unlock.");
      return;
    }
    router.refresh();
  }, [props.templateId, router]);

  const sessionIdRef = useSessionIdMirror(props.templateId);

  const handleSave = useCallback(
    (markReady: boolean) =>
      async (design: object, html: string) => {
        setError(null);
        setInfo(null);
        const sessionId = sessionIdRef();
        if (!sessionId) {
          setError(
            "Lock not acquired yet — wait a moment for the editor to attach.",
          );
          return;
        }
        await new Promise<void>((resolve) => {
          startSaveTransition(async () => {
            const result = await updateTemplateAction({
              id: props.templateId,
              name,
              subject,
              preheader: preheader.trim() ? preheader : null,
              description: description.trim() ? description : null,
              unlayerDesignJson: design,
              renderedHtml: html,
              markReady,
              sessionId,
            });
            if (!result.ok) {
              setError(result.error);
            } else {
              if (markReady) setStatus("ready");
              setInfo("Saved.");
              router.refresh();
            }
            resolve();
          });
        });
      },
    [
      description,
      name,
      preheader,
      props.templateId,
      router,
      sessionIdRef,
      subject,
    ],
  );

  function handleArchive() {
    setError(null);
    setInfo(null);
    if (!confirm("Archive this template? Campaigns already sent will keep working; new sends are blocked.")) {
      return;
    }
    startArchiveTransition(async () => {
      const result = await archiveTemplateAction(props.templateId);
      if (!result.ok) {
        setError(result.error);
      }
    });
  }

  function handleSendTest() {
    setError(null);
    setInfo(null);
    startTestTransition(async () => {
      const result = await sendTestTemplateAction({
        id: props.templateId,
        recipientEmail: testRecipient,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInfo(`Test sent (message id ${result.data.messageId}).`);
      setTestOpen(false);
    });
  }

  // Promote/demote handler. Server enforces the
  // creator + canMarketingTemplatesEdit gates; the UI just hides the
  // controls when the local props say they don't apply.
  function handleSaveScope() {
    setError(null);
    setInfo(null);
    if (pendingScope === currentScope) {
      setInfo("Visibility is already set to that value.");
      return;
    }
    startScopeTransition(async () => {
      const fd = new FormData();
      fd.set("id", props.templateId);
      fd.set("version", String(scopeVersion));
      fd.set("newScope", pendingScope);
      const result = await changeTemplateScopeAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCurrentScope(pendingScope);
      setScopeVersion(scopeVersion + 1);
      setInfo(
        pendingScope === "global"
          ? "Template is now visible to everyone with template permissions."
          : "Template is now visible only to you.",
      );
      router.refresh();
    });
  }

  // Visibility section visibility rules:
  // Creator always sees the section (read-only display if they
  // can't toggle to the other side, e.g. trying to demote without
  // canMarketingTemplatesEdit).
  // Non-creator non-admin sees only the current value (no radio).
  // Admin always sees the radio.
  const canChangeScope =
    props.isAdmin || props.isCreator;
  const canDemoteToPersonal =
    props.isAdmin ||
    (props.isCreator && props.canMarketingTemplatesEdit);

  // Replace editor mount with banner when locked.
  if (showInitialBanner && initialHolder) {
    return (
      <LockedTemplateBanner
        templateId={props.templateId}
        holder={initialHolder}
        isAdmin={props.isAdmin}
        onForceUnlock={handleForceUnlock}
      />
    );
  }
  if (showLockBanner && lock.holder) {
    return (
      <LockedTemplateBanner
        templateId={props.templateId}
        holder={lock.holder}
        isAdmin={props.isAdmin}
        onForceUnlock={handleForceUnlock}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        name={name}
        setName={setName}
        subject={subject}
        setSubject={setSubject}
        preheader={preheader}
        setPreheader={setPreheader}
        description={description}
        setDescription={setDescription}
        status={status}
        archivePending={archivePending}
        savePending={savePending}
        onArchive={handleArchive}
        onOpenTest={() => setTestOpen(true)}
      />

      <VisibilitySection
        currentScope={currentScope}
        pendingScope={pendingScope}
        onChangePending={setPendingScope}
        onSave={handleSaveScope}
        pending={scopePending}
        canChange={canChangeScope}
        canDemoteToPersonal={canDemoteToPersonal}
      />

      {error ? (
        <p className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="rounded-md border border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] px-3 py-2 text-sm text-[var(--status-won-fg)]">
          {info}
        </p>
      ) : null}

      <UnlayerEditor
        configured={props.unlayerConfigured}
        projectId={props.unlayerProjectId ?? 0}
        initialDesign={
          props.initialDesign &&
          typeof props.initialDesign === "object" &&
          Object.keys(props.initialDesign as Record<string, unknown>).length > 0
            ? (props.initialDesign as object)
            : null
        }
        onSave={handleSave(false)}
        onSendTest={() => setTestOpen(true)}
        saveLabel={status === "draft" ? "Save draft" : "Save"}
      />

      <div className="flex justify-end">
        {status === "draft" ? (
          <button
            type="button"
            disabled={savePending}
            onClick={async () => {
              // Promote-to-ready piggy-backs the same export → save flow.
              // We can't trigger Unlayer's exportHtml from outside the
              // editor without a ref-bridge; the simplest path is a
              // hint that the user hits Save first. Surface that with
              // an inline note.
              setInfo("Save the design first, then mark ready below.");
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            (Use Save above; mark-ready in the next pass)
          </button>
        ) : null}
      </div>

      {testOpen ? (
        <TestSendModal
          recipient={testRecipient}
          setRecipient={setTestRecipient}
          pending={testPending}
          onClose={() => setTestOpen(false)}
          onSend={handleSendTest}
        />
      ) : null}
    </div>
  );
}

interface ToolbarProps {
  name: string;
  setName: (v: string) => void;
  subject: string;
  setSubject: (v: string) => void;
  preheader: string;
  setPreheader: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  status: TemplateStatus;
  savePending: boolean;
  archivePending: boolean;
  onArchive: () => void;
  onOpenTest: () => void;
}

function Toolbar(props: ToolbarProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            type="text"
            value={props.name}
            onChange={(e) => props.setName(e.target.value)}
            disabled={props.savePending}
            maxLength={200}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="Subject">
          <input
            type="text"
            value={props.subject}
            onChange={(e) => props.setSubject(e.target.value)}
            disabled={props.savePending}
            maxLength={998}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="Preheader">
          <input
            type="text"
            value={props.preheader}
            onChange={(e) => props.setPreheader(e.target.value)}
            disabled={props.savePending}
            maxLength={255}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
        <Field label="Description">
          <input
            type="text"
            value={props.description}
            onChange={(e) => props.setDescription(e.target.value)}
            disabled={props.savePending}
            maxLength={2000}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <StatusPillLocal status={props.status} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onOpenTest}
            disabled={props.savePending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" aria-hidden /> Send test
          </button>
          <button
            type="button"
            onClick={props.onArchive}
            disabled={props.archivePending || props.status === "archived"}
            className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
          >
            {props.archivePending ? "Archiving…" : "Archive"}
          </button>
        </div>
      </div>
    </div>
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
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatusPillLocal({ status }: { status: TemplateStatus }) {
  const className =
    status === "ready"
      ? "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]"
      : status === "archived"
        ? "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
        : "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  const label =
    status === "ready" ? "Ready" : status === "archived" ? "Archived" : "Draft";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

interface TestSendModalProps {
  recipient: string;
  setRecipient: (v: string) => void;
  pending: boolean;
  onClose: () => void;
  onSend: () => void;
}

function TestSendModal({
  recipient,
  setRecipient,
  pending,
  onClose,
  onSend,
}: TestSendModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl">
        <h2 className="text-base font-semibold text-foreground">
          Send a test
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A single rendered copy goes to the address below. Suppression
          and quiet-hours rules are bypassed for tests.
        </p>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recipient email
          <input
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={pending}
            className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={pending || !recipient}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            {pending ? "Sending…" : "Send test"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface VisibilitySectionProps {
  currentScope: TemplateScope;
  pendingScope: TemplateScope;
  onChangePending: (next: TemplateScope) => void;
  onSave: () => void;
  pending: boolean;
  canChange: boolean;
  canDemoteToPersonal: boolean;
}

/**
 * Inline scope toggle on the editor page.
 *
 * Read-only when the viewer can't change scope (renders the current
 * value with explanatory hint). Otherwise renders the radio + Save
 * button. The "Global → Personal" option is disabled when the user
 * lacks `canMarketingTemplatesEdit` (creator can promote freely, but
 * demoting hides a shared template from everyone else and requires
 * the edit gate).
 */
function VisibilitySection(props: VisibilitySectionProps) {
  const dirty = props.pendingScope !== props.currentScope;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Visibility
          </h2>
          <p className="mt-1 text-xs text-muted-foreground/80">
            Controls who can see this template in the list and pick it
            for a campaign.
          </p>
        </div>
        {props.canChange && dirty ? (
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-60"
          >
            {props.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            {props.pending ? "Saving…" : "Save visibility"}
          </button>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <VisibilityOption
          value="global"
          checked={props.pendingScope === "global"}
          onChange={() => props.onChangePending("global")}
          disabled={!props.canChange || props.pending}
          label="Global"
          hint="Visible to everyone with template permissions."
        />
        <VisibilityOption
          value="personal"
          checked={props.pendingScope === "personal"}
          onChange={() => props.onChangePending("personal")}
          // Demote disabled if the user can't demote. Promote-only
          // creators get a visible-but-locked Personal option so they
          // see why the toggle is unavailable.
          disabled={
            !props.canChange ||
            props.pending ||
            (props.currentScope === "global" && !props.canDemoteToPersonal)
          }
          label="Personal"
          hint={
            props.currentScope === "global" && !props.canDemoteToPersonal
              ? "Requires edit permission to hide a global template."
              : "Only you can see and use this template."
          }
        />
      </div>
    </section>
  );
}

interface VisibilityOptionProps {
  value: TemplateScope;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  hint: string;
}

function VisibilityOption(props: VisibilityOptionProps) {
  return (
    <label
      className={`flex items-start gap-2 rounded-md border px-3 py-2 transition ${
        props.checked
          ? "border-ring/60 bg-accent/30"
          : "border-border bg-input"
      } ${
        props.disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-accent/15"
      }`}
    >
      <input
        type="radio"
        name="visibility-scope"
        value={props.value}
        checked={props.checked}
        onChange={props.onChange}
        disabled={props.disabled}
        className="mt-0.5 h-4 w-4 border-border text-primary focus:ring-ring/40"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {props.label}
        </span>
        <span className="text-xs text-muted-foreground/80">{props.hint}</span>
      </span>
    </label>
  );
}

/**
 * Mirror the per-tab session id the lock hook generates so the
 * server-action save call can include it. The hook owns the canonical
 * value via `useRef`; we read from `sessionStorage` (set on mount in
 * `useTemplateLock` indirectly via the outbound POST headers).
 *
 * Implementation note: the hook does not currently expose its
 * sessionId. To keep this scoped to a single sub-agent's surface area
 * we mint a parallel id here and stash it under a stable key. The
 * server only cares whether SOME sessionId matches the lock holder —
 * since the hook also acquires under that same id, we generate the
 * id once per (template, tab) and reuse it from both call sites.
 */
function useSessionIdMirror(templateId: string): () => string | null {
  const key = `mwg-tpl-lock:${templateId}`;
  return () => {
    if (typeof window === "undefined") return null;
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const minted =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    window.sessionStorage.setItem(key, minted);
    return minted;
  };
}
