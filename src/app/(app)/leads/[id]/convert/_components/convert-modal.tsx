"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { StandardDialog } from "@/components/standard";
import { convertLeadAction } from "../actions";

const CONTROL_CLASS =
  "mt-1 h-9 w-full rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40";

interface ConvertModalProps {
  leadId: string;
  /**
   * display name used in the modal intro line.
   * Falls back to "this lead" when blank so the copy still reads.
   */
  leadDisplayName: string | null;
  defaultCompany: string | null;
  defaultFirstName: string;
  defaultLastName: string | null;
  defaultJobTitle: string | null;
  defaultEmail: string | null;
  defaultPhone: string | null;
  defaultMobile: string | null;
  defaultEstValue: string | null;
}

export function ConvertModal(props: ConvertModalProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [createContact, setCreateContact] = useState(true);
  const [createOpp, setCreateOpp] = useState(true);

  const [accountName, setAccountName] = useState(props.defaultCompany ?? "");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [contactFirst, setContactFirst] = useState(props.defaultFirstName);
  const [contactLast, setContactLast] = useState(props.defaultLastName ?? "");
  const [contactEmail, setContactEmail] = useState(props.defaultEmail ?? "");
  const [oppName, setOppName] = useState(
    `${props.defaultCompany ?? "Lead"} - ${new Date().toLocaleDateString()}`,
  );
  const [oppAmount, setOppAmount] = useState(props.defaultEstValue ?? "");

  function submit() {
    if (!accountName.trim()) {
      setAccountError("Account name is required.");
      toast.error("Account name is required.");
      return;
    }
    setAccountError(null);
    startTransition(async () => {
      const res = await convertLeadAction({
        leadId: props.leadId,
        newAccount: { name: accountName.trim() },
        newContact: createContact
          ? {
              firstName: contactFirst.trim(),
              lastName: contactLast.trim(),
              jobTitle: props.defaultJobTitle,
              email: contactEmail.trim() || null,
              phone: props.defaultPhone,
              mobilePhone: props.defaultMobile,
            }
          : null,
        newOpportunity: createOpp
          ? {
              name: oppName.trim(),
              // Post raw text; optionalMoneyField parses/validates it
              // (a mistyped amount surfaces an error, never a silent
              // null — the field is type="text", not a number input
              // the browser would blank).
              amount: oppAmount.trim() || null,
            }
          : null,
      });
      if (res && !res.ok) {
        toast.error(res.error);
      }
      // On success, the action redirects.
    });
  }

  return (
    <StandardDialog
      open={open}
      // Block dismissal (Escape / outside-click) while a conversion is in
      // flight so the modal can't be re-opened and re-submitted into a
      // duplicate convert; Cancel is inert mid-submit for the same reason.
      onOpenChange={(next) => {
        if (!next && pending) return;
        setOpen(next);
      }}
      disableOutsideClose={pending}
      trigger={
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Convert
        </button>
      }
      title="Convert lead"
      description={
        <>
          This will convert{" "}
          <span className="font-medium text-foreground">
            {props.leadDisplayName?.trim() || "this lead"}
          </span>{" "}
          into an Account, Contact, and Opportunity. The lead will be marked as
          qualified and removed from the active leads view.
        </>
      }
      footer={
        <>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm hover:bg-accent/40 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !accountName.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Converting…" : "Convert"}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {/* Account */}
        <div>
          <label
            htmlFor="convert-account-name"
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Account name *
          </label>
          <input
            id="convert-account-name"
            type="text"
            value={accountName}
            onChange={(e) => {
              setAccountName(e.target.value);
              if (accountError) setAccountError(null);
            }}
            aria-invalid={accountError ? true : undefined}
            aria-describedby={accountError ? "convert-account-name-error" : undefined}
            className={CONTROL_CLASS}
          />
          {accountError ? (
            <p
              id="convert-account-name-error"
              role="alert"
              className="mt-1 text-xs text-[var(--status-lost-fg)]"
            >
              {accountError}
            </p>
          ) : null}
        </div>

        {/* Contact */}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={createContact}
            onChange={(e) => setCreateContact(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/40"
          />
          <span>Create contact</span>
        </label>
        {createContact ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={contactFirst}
              onChange={(e) => setContactFirst(e.target.value)}
              placeholder="First name"
              className={CONTROL_CLASS}
            />
            <input
              type="text"
              value={contactLast}
              onChange={(e) => setContactLast(e.target.value)}
              placeholder="Last name"
              className={CONTROL_CLASS}
            />
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email"
              className={`${CONTROL_CLASS} sm:col-span-2`}
            />
          </div>
        ) : null}

        {/* Opportunity */}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={createOpp}
            onChange={(e) => setCreateOpp(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/40"
          />
          <span>Create opportunity</span>
        </label>
        {createOpp ? (
          <div className="grid grid-cols-1 gap-2">
            <input
              type="text"
              value={oppName}
              onChange={(e) => setOppName(e.target.value)}
              placeholder="Opportunity name"
              className={CONTROL_CLASS}
            />
            <input
              type="text"
              inputMode="decimal"
              value={oppAmount}
              onChange={(e) => setOppAmount(e.target.value)}
              placeholder="Amount (optional)"
              className={CONTROL_CLASS}
            />
          </div>
        ) : null}
      </div>
    </StandardDialog>
  );
}
