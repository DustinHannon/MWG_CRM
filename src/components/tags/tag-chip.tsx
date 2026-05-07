import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagChipProps {
  name: string;
  color?: string;
  size?: "sm" | "md";
  onRemove?: () => void;
  className?: string;
}

const COLOR_CLASSES: Record<string, string> = {
  slate: "bg-tag-slate text-tag-slate-foreground",
  navy: "bg-tag-navy text-tag-navy-foreground",
  blue: "bg-tag-blue text-tag-blue-foreground",
  teal: "bg-tag-teal text-tag-teal-foreground",
  green: "bg-tag-green text-tag-green-foreground",
  amber: "bg-tag-amber text-tag-amber-foreground",
  gold: "bg-tag-gold text-tag-gold-foreground",
  orange: "bg-tag-orange text-tag-orange-foreground",
  rose: "bg-tag-rose text-tag-rose-foreground",
  violet: "bg-tag-violet text-tag-violet-foreground",
  gray: "bg-tag-gray text-tag-gray-foreground",
};

/** Small colored pill for a tag. Optional × removes it. */
export function TagChip({
  name,
  color = "slate",
  size = "sm",
  onRemove,
  className,
}: TagChipProps) {
  const colorClass = COLOR_CLASSES[color] ?? COLOR_CLASSES.slate;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        colorClass,
        className,
      )}
    >
      {name}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="-mr-0.5 ml-0.5 rounded-full p-0.5 hover:bg-foreground/10"
        >
          <X size={10} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
