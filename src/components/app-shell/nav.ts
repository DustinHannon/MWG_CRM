export type NavItem =
  | { label: string; href: string }
  | { divider: true };

export function isDivider(
  item: NavItem,
): item is { divider: true } {
  return "divider" in item && item.divider === true;
}
