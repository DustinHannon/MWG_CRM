"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { convertLeadAction } from "../actions";

interface ConvertModalProps {
  leadId: string;
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
  const [contactFirst, setContactFirst] = useState(props.defaultFirstName);
  const [contactLast, setContactLast] = useState(props.defaultLastName ?? "");
  const [contactEmail, setContactEmail] = useState(props.defaultEmail ?? "");
  const [oppName, setOppName] = useState(
    `${props.defaultCompany ?? "Lead"} - ${new Date().toLocaleDateString()}`,
  );
  const [oppAmount, setOppAmount] = useState(props.defaultEstValue ?? "");

  function submit() {
    if (!accountName.trim()) {
      toast.error("Account name is required.");
      return;
    }
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
              amount: oppAmount ? Number(oppAmount) : null,
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Convert
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="glass-surface glass-surface--3 w-full max-w-xl rounded-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Convert lead</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Creates an Account from the lead&apos;s company info, plus
              optional Contact and Opportunity records. Activities reassign
              to the new opportunity.
            </p>

            <div className="mt-5 space-y-4 text-sm">
              {/* Account */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Account name *
                </label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-glass-border bg-input/60 px-3"
                />
              </div>

              {/* Contact */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={createContact}
                  onChange={(e) => setCreateContact(e.target.checked)}
                  className="h-4 w-4 rounded border-glass-border bg-input/60"
                />
                <span>Create contact</span>
              </label>
              {createContact ? (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={contactFirst}
                    onChange={(e) => setContactFirst(e.target.value)}
                    placeholder="First name"
                    className="h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
                  />
                  <input
                    type="text"
                    value={contactLast}
                    onChange={(e) => setContactLast(e.target.value)}
                    placeholder="Last name"
                    className="h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
                  />
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="Email"
                    className="col-span-2 h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
                  />
                </div>
              ) : null}

              {/* Opportunity */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={createOpp}
                  onChange={(e) => setCreateOpp(e.target.checked)}
                  className="h-4 w-4 rounded border-glass-border bg-input/60"
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
                    className="h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
                  />
                  <input
                    type="number"
                    value={oppAmount}
                    onChange={(e) => setOppAmount(e.target.value)}
                    placeholder="Amount (optional)"
                    className="h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-glass-border bg-input/40 px-3 py-1.5 text-sm hover:bg-accent/40"
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
