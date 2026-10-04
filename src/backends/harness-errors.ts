/**
 * Typed failures at provider-neutral harness boundaries.
 */

import { DomainError, type DomainErrorOptions } from "../domain/domain-error";

export type HarnessErrorCode =
  | "harness_unsupported_feature"
  | "harness_session_not_found"
  | "harness_session_not_owned"
  | "harness_event_gap"
  | "harness_activity_not_owned"
  | "harness_request_failed"
  | "harness_transport_closed"
  | "harness_runtime_unavailable"
  | "harness_authentication_required"
  | "harness_connection_aborted"
  | "harness_model_not_available"
  | "harness_input_not_found"
  | "harness_input_unresolved"
  | "harness_input_capacity"
  | "harness_question_invalid"
  | "harness_question_not_found"
  | "harness_question_closed"
  | "harness_question_unconfirmed"
  | "harness_invalid_model_option";

export class HarnessError extends DomainError<HarnessErrorCode> {
  constructor(code: HarnessErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(code, message, options);
    this.name = "HarnessError";
  }
}
