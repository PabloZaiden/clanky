import { z } from "zod";
import { ControlToolInvocationSchema } from "./control";
import { MeshProtocolVersionSchema } from "./mesh-protocol";

export const ControlToolRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), chatId: z.string().min(1).max(500).optional() }).strict(),
  ControlToolInvocationSchema.extend({
    operation: z.literal("call"), name: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
  }).strict(),
]);
export type ControlToolRequest = z.infer<typeof ControlToolRequestSchema>;

export const MeshControlToolRequestSchema = z.object({
  protocolVersion: MeshProtocolVersionSchema,
  requestId: z.string().uuid(),
  workerNodeId: z.string().min(1).max(200),
  credential: z.string().min(1).max(4096),
  request: ControlToolRequestSchema,
}).strict();
