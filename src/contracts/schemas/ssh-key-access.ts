import { z } from "zod";
import { MESH_SSH_AGENT_VERSION, SSH_AGENT_MAX_FRAME_BYTES } from "@/shared/ssh-key-access";

const Id = z.string().uuid();
const Host = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), nodeId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("mesh"), nodeId: z.string().min(1).max(200) }).strict(),
]);
export const RegisterSshKeySourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: Host,
}).strict();
export const RegisterSshPublicKeySchema = z.object({
  publicKey: z.string().min(4).max(24 * 1024),
  alias: z.string().trim().min(1).max(100),
}).strict();
export const SetWorkspaceSshKeyGrantSchema = z.object({ enabled: z.boolean() }).strict();
export const SshAgentOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capability") }).strict(),
  z.object({ kind: z.literal("source-list") }).strict(),
  z.object({ kind: z.literal("open-workspace") }).strict(),
  z.object({
    kind: z.literal("source-sign"),
    publicKey: z.string().min(4).max(24 * 1024),
    data: z.string().max(SSH_AGENT_MAX_FRAME_BYTES * 2),
    flags: z.union([z.literal(0), z.literal(2), z.literal(4)]),
  }).strict(),
  z.object({
    kind: z.literal("workspace-request"),
    leaseId: Id.optional(),
    frame: z.string().min(4).max(SSH_AGENT_MAX_FRAME_BYTES * 2),
  }).strict(),
  z.object({
    kind: z.literal("open-lease"),
    leaseId: Id,
    expiresAt: z.number().int().positive(),
  }).strict(),
  z.object({ kind: z.literal("close-lease"), leaseId: Id }).strict(),
]);
export const MeshSshAgentRequestSchema = z.object({
  protocolVersion: z.literal(7),
  sshAgent: z.literal(MESH_SSH_AGENT_VERSION),
  senderNodeId: z.string().min(1).max(200),
  recipientNodeId: z.string().min(1).max(200),
  requestId: Id,
  issuedAt: z.number().int().positive(),
  operation: SshAgentOperationSchema,
  signature: z.string().min(1).max(1024),
}).strict();
export type MeshSshAgentRequest = z.infer<typeof MeshSshAgentRequestSchema>;
export type SshAgentOperation = z.infer<typeof SshAgentOperationSchema>;
export const MeshSshAgentResponseSchema = z.object({
  protocolVersion: z.literal(7),
  sshAgent: z.literal(MESH_SSH_AGENT_VERSION),
  senderNodeId: z.string().min(1).max(200),
  recipientNodeId: z.string().min(1).max(200),
  requestId: Id,
  payload: z.unknown(),
  signature: z.string().min(1).max(1024),
}).strict();
