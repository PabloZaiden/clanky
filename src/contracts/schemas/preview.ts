/**
 * TLS and VS Code startup contracts carried by the authenticated preview bridge.
 */

import { z } from "zod";

export const PreviewUpstreamOptionsSchema = z.object({
  protocol: z.enum(["http", "https"]).default("http"),
});

export const CodePreviewOptionsSchema = z.object({
  chat: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  acceptServerLicenseTerms: z.boolean(),
}).strict().refine((value) => !(value.chat && value.task), {
  message: "--chat and --task may not be used together",
});

export const CodePreviewHelloSchema = z.object({
  type: z.literal("hello"),
  target: z.object({
    kind: z.literal("workspace"),
    reference: z.string().trim().min(1),
  }),
  code: CodePreviewOptionsSchema,
  protocol: z.literal("http").optional(),
  remoteHost: z.literal("127.0.0.1"),
  remotePort: z.literal(0),
  localHost: z.literal("127.0.0.1"),
  localPort: z.number().int().min(1).max(65535),
  localUrl: z.string().url(),
  initialPath: z.literal("/"),
  cliHostname: z.string().max(255).optional(),
}).refine((value) => value.localUrl === `http://127.0.0.1:${String(value.localPort)}/`, {
  message: "Code previews require a loopback listener at the origin root",
});
