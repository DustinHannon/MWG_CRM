import "server-only";
import { mapD365Account, type AccountMapContext, type NewAccount } from "./account";
import {
  mapD365Annotation,
  type AnnotationMapContext,
} from "./annotation";
import {
  mapD365Appointment,
  type AppointmentMapContext,
} from "./appointment";
import { mapD365Contact, type ContactMapContext, type NewContact } from "./contact";
import { mapD365Email, type EmailMapContext } from "./email";
import { mapD365Lead, type LeadMapContext, type NewLead } from "./lead";
import {
  mapD365Opportunity,
  type NewOpportunity,
  type OpportunityMapContext,
} from "./opportunity";
import {
  mapD365Phonecall,
  type PhoneCallMapContext,
} from "./phonecall";
import { mapD365Task, type NewTask, type TaskMapContext } from "./task";

/**
 * mapping registry barrel.
 *
 * Exports every entity-specific mapper. The root-aggregate orchestrator
 * (`map-batch.ts`) dispatches the four ROOT mappers directly by root
 * type; child mappers are invoked from the root mappers via
 * `mapAttachedChildren`, so no type-erased registry dispatcher is needed.
 */

export {
  mapD365Lead,
  mapD365Contact,
  mapD365Account,
  mapD365Opportunity,
  mapD365Annotation,
  mapD365Task,
  mapD365Phonecall,
  mapD365Appointment,
  mapD365Email,
};

export type {
  LeadMapContext,
  ContactMapContext,
  AccountMapContext,
  OpportunityMapContext,
  AnnotationMapContext,
  TaskMapContext,
  PhoneCallMapContext,
  AppointmentMapContext,
  EmailMapContext,
  NewLead,
  NewContact,
  NewAccount,
  NewOpportunity,
  NewTask,
};

export {
  type AttachedActivity,
  type AttachedActivityKind,
  type AttachedSourceEntityType,
  type ChildParentContext,
  type D365RootEntityType,
  type MapResult,
  type ValidationWarning,
  MappingError,
  extractCustomFields,
  parseBoolean,
  parseODataDate,
  parseOptionalDate,
  parseString,
  parseNumber,
  picklistMapper,
  softValidate,
} from "./parsers";

export {
  mapAttachedChildren,
  isChildWarning,
  CHILD_WARNING_FIELD_PREFIX,
  type ChildOwnerResolver,
  type D365Children,
} from "./children";
