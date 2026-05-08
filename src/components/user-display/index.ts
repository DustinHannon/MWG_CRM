/**
 * Phase 9B — canonical user-display primitives. Sub-agent A in Phase 9C
 * replaces every text-only "owner email" / "owner name" rendering site
 * with these. Sub-agent A is the ONLY consumer pattern; the components
 * themselves stay locked.
 */
export { UserAvatar, resolveName, type UserAvatarSize, type UserAvatarUserShape } from "./user-avatar";
export { UserChip } from "./user-chip";
export { UserHoverCard } from "./user-hover-card";
