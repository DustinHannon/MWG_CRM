import type { LucideIcon } from "lucide-react";

export type NavItem =
  | { label: string; href: string; icon?: LucideIcon }
  | { divider: true };

export function isDivider(
  item: NavItem,
): item is { divider: true } {
  return "divider" in item && item.divider === true;
}
