/**
 * Data-only client policy projected from canonical application route definitions.
 */

import type { RouteOperation } from "@pablozaiden/webapp/routing";
import type { RouteDelegationMetadata } from "@/platform/contracts";

export interface CollaborationReadMetadata {
  readOnly: boolean;
  nativeRead: boolean;
  conversation: boolean;
  nativeQueryFields: readonly string[];
  hiddenInputs: readonly string[];
}

export interface CollaborationOperationMetadata {
  delegation: Readonly<RouteDelegationMetadata> | false;
  read?: CollaborationReadMetadata;
}

export type CollaborationRouteOperation = RouteOperation<CollaborationOperationMetadata>;
