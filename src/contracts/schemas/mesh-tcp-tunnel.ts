import { z } from "zod";
import {
  MESH_TCP_TUNNEL_CAPABILITY,
  MESH_TCP_TUNNEL_PROTOCOL_VERSION,
} from "@/shared/mesh-tcp-tunnel";

export const MeshTcpTunnelSessionRequestSchema = z.object({
  protocolVersion: z.literal(MESH_TCP_TUNNEL_PROTOCOL_VERSION),
  capability: z.literal(MESH_TCP_TUNNEL_CAPABILITY),
  requestId: z.string().trim().min(1).max(200),
  callerNodeId: z.string().trim().min(1).max(200),
  callerPublicKey: z.string().min(1).max(16_384),
  callerFingerprint: z.string().trim().min(1).max(200),
  callerEncryptionPublicKey: z.string().min(1).max(16_384),
  targetNodeId: z.string().trim().min(1).max(200),
  remoteHost: z.literal("127.0.0.1"),
  remotePort: z.number().int().min(1).max(65_535),
  nonce: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1).max(16_384),
});

export type MeshTcpTunnelSessionRequest = z.infer<
  typeof MeshTcpTunnelSessionRequestSchema
>;
