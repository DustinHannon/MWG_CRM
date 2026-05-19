import "server-only";

/**
 * pure ownership/admin checks for delete affordances. These are
 * synchronous client-and-server helpers used to gate UI rendering AND
 * server actions. The server action MUST re-fetch the record before calling
 * these (never trust the client to claim ownership).
 *
 * Rules per the matrix:
 * Lead/Account/Contact/Opportunity: owner OR admin can soft-delete
 * Task: creator OR assignee OR admin
 * Activity: author (user_id) OR admin for this predicate, shared by
 *   soft-delete (canDeleteActivity) and inline edit (canEditActivity).
 *   NOTE the EDIT path is stricter than delete at the action layer:
 *   `updateActivityAction` (and the conflict-state read) also call
 *   `requireLeadAccess` before this check; `softDeleteActivityAction`
 *   does not. This predicate is the author/admin half only — not the
 *   full edit gate.
 * Hard delete (any entity): admin only, from archive view
 *
 * `canViewAllRecords` deliberately does NOT grant delete. View ≠ delete.
 */

interface ActorLite {
  id: string;
  isAdmin: boolean;
}

interface OwnedLite {
  ownerId: string | null;
}

interface TaskLite {
  createdById: string | null;
  assignedToId: string | null;
}

interface ActivityLite {
  /** activities.user_id — the author. */
  userId: string | null;
}

export function canDeleteLead(user: ActorLite, lead: OwnedLite): boolean {
  if (user.isAdmin) return true;
  return lead.ownerId === user.id;
}

export function canDeleteAccount(user: ActorLite, account: OwnedLite): boolean {
  if (user.isAdmin) return true;
  return account.ownerId === user.id;
}

export function canDeleteContact(user: ActorLite, contact: OwnedLite): boolean {
  if (user.isAdmin) return true;
  return contact.ownerId === user.id;
}

export function canDeleteOpportunity(
  user: ActorLite,
  opp: OwnedLite,
): boolean {
  if (user.isAdmin) return true;
  return opp.ownerId === user.id;
}

export function canDeleteTask(user: ActorLite, task: TaskLite): boolean {
  if (user.isAdmin) return true;
  return task.createdById === user.id || task.assignedToId === user.id;
}

export function canDeleteActivity(
  user: ActorLite,
  activity: ActivityLite,
): boolean {
  if (user.isAdmin) return true;
  return activity.userId === user.id;
}

/**
 * Author/admin half of the inline-edit gate for a note/call timeline
 * entry (an activity's author may correct their own note/call; admins
 * may correct anyone's). This predicate body is identical to
 * `canDeleteActivity` today, but the full EDIT gate is stricter than
 * delete: `updateActivityAction` and `getActivityForConflictAction`
 * also require `requireLeadAccess` before calling this, whereas
 * `softDeleteActivityAction` does not check lead access. Behavior-named
 * rather than reusing the delete helper so the call site reads as an
 * edit check; the two concerns are allowed to diverge.
 */
export function canEditActivity(
  user: ActorLite,
  activity: ActivityLite,
): boolean {
  if (user.isAdmin) return true;
  return activity.userId === user.id;
}

export function canHardDelete(user: ActorLite): boolean {
  return user.isAdmin === true;
}
