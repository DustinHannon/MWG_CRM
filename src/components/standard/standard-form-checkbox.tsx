"use client";

export interface StandardFormCheckboxProps {
  name: string;
  label: string;
  defaultChecked?: boolean;
  /** Controlled mode (dialogs that need the value before submit). */
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

/** Canonical labeled checkbox — matches lead-form's DNC checkbox markup. */
export function StandardFormCheckbox({
  name,
  label,
  defaultChecked,
  checked,
  onChange,
  disabled,
}: StandardFormCheckboxProps) {
  return (
    <label
      className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}
      aria-disabled={disabled}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring disabled:cursor-not-allowed"
      />
      <span>{label}</span>
    </label>
  );
}
