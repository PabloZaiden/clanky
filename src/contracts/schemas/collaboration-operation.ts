/**
 * Data contract for a generated, handler-free collaboration operation catalog.
 */

import { z } from "zod";
import { HTTP_METHODS } from "@pablozaiden/webapp/routing";
import type { CollaborationRouteOperation } from "@/shared/collaboration-operation";

const ReferenceBindingSchema = z.object({
  source: z.enum(["param", "query", "body"]),
  name: z.string().min(1).max(200),
  resource: z.string().min(1).max(200),
}).strict();

const OperationSchema: z.ZodType<CollaborationRouteOperation> = z.object({
  path: z.string().startsWith("/api/").max(4096),
  method: z.enum(HTTP_METHODS),
  metadata: z.object({
    delegation: z.union([z.literal(false), z.object({
      resource: z.string().min(1).max(200),
      action: z.string().min(1).max(200),
      bindings: z.array(ReferenceBindingSchema).max(100).optional(),
      collection: z.boolean().optional(),
    }).strict()]),
    read: z.object({
      readOnly: z.boolean(),
      nativeRead: z.boolean(),
      conversation: z.boolean(),
      nativeQueryFields: z.array(z.string().max(200)).max(200),
      hiddenInputs: z.array(z.string().max(200)).max(200),
    }).strict().optional(),
  }).strict(),
}).strict();

export const CollaborationOperationCatalogSchema = z.array(OperationSchema).max(4096);
