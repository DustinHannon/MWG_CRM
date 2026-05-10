import "server-only";
import type { D365EntityType } from "../types";
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
 * Phase 23 — mapping registry barrel.
 *
 * Exports every entity-specific mapper plus a dispatcher
 * (`getMapperForEntity`) the orchestrator uses when iterating
 * `import_records` rows of mixed entity types.
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

/**
 * Type-erased dispatcher. Returned function signature is intentionally
 * loose — orchestrator code keeps the raw payload as `unknown` (since
 * each row in a batch may be a different entity type) and casts at
 * the dispatch site.
 */
export type GenericMapper = (
  raw: unknown,
  ctx: unknown,
) => unknown;

/**
 * Map an entity-type string to the matching mapper function. Throws
 * if the entity isn't supported (orchestrator catches and flips the
 * record to status='failed').
 */
export function getMapperForEntity(entityType: D365EntityType): GenericMapper {
  switch (entityType) {
    case "lead":
      return mapD365Lead as unknown as GenericMapper;
    case "contact":
      return mapD365Contact as unknown as GenericMapper;
    case "account":
      return mapD365Account as unknown as GenericMapper;
    case "opportunity":
      return mapD365Opportunity as unknown as GenericMapper;
    case "annotation":
      return mapD365Annotation as unknown as GenericMapper;
    case "task":
      return mapD365Task as unknown as GenericMapper;
    case "phonecall":
      return mapD365Phonecall as unknown as GenericMapper;
    case "appointment":
      return mapD365Appointment as unknown as GenericMapper;
    case "email":
      return mapD365Email as unknown as GenericMapper;
    default: {
      const _exhaustive: never = entityType;
      void _exhaustive;
      // invariant: TypeScript exhaustive-check above guarantees
      // this branch is unreachable. A new D365EntityType added
      // without a mapper registration lands here.
      throw new Error(`No mapper registered for entity type: ${entityType}`);
    }
  }
}
