/**
 * Exact-path filesystem contracts used by the local WebDAV bridge.
 */

import { z } from "zod";

export const FILE_SYSTEM_MAX_METADATA_BYTES = 16 * 1_024 * 1_024;

const PathSchema = z.string().min(1).max(16_384).refine((value) => !value.includes("\0"));
const OwnerSchema = z.string().uuid();

export const FileSystemConditionsSchema = z.object({
  ifMatch: z.string().max(8_192).optional(),
  ifNoneMatch: z.string().max(8_192).optional(),
  davIf: z.array(z.object({
    path: PathSchema.optional(),
    terms: z.array(z.object({
      kind: z.enum(["token", "etag"]),
      value: z.string().max(8_192),
      not: z.boolean(),
    })).min(1).max(32),
  })).max(32).optional(),
});

const mutation = {
  path: PathSchema,
  conditions: FileSystemConditionsSchema.optional(),
};

export const FileSystemCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("info") }),
  z.object({
    operation: z.literal("stat"),
    path: PathSchema,
    hash: z.boolean().optional().default(false),
  }),
  z.object({ operation: z.literal("list"), path: PathSchema }),
  z.object({ operation: z.literal("mkdir"), ...mutation }),
  z.object({ operation: z.literal("delete"), ...mutation }),
  z.object({
    operation: z.enum(["move", "copy"]),
    ...mutation,
    destination: PathSchema,
    overwrite: z.boolean(),
    depth: z.enum(["0", "infinity"]).optional().default("infinity"),
  }),
  z.object({
    operation: z.literal("lock"),
    path: PathSchema,
    ownerId: OwnerSchema,
    scope: z.enum(["exclusive", "shared"]),
    depth: z.enum(["0", "infinity"]),
    owner: z.string().max(8_192),
    timeoutSeconds: z.number().int().min(1).max(3_600),
    conditions: FileSystemConditionsSchema.optional(),
  }),
  z.object({
    operation: z.literal("refreshLock"),
    path: PathSchema,
    ownerId: OwnerSchema,
    conditions: FileSystemConditionsSchema,
    timeoutSeconds: z.number().int().min(1).max(3_600),
  }),
  z.object({
    operation: z.literal("unlock"),
    path: PathSchema,
    token: z.string().max(256),
    ownerId: OwnerSchema,
  }),
  z.object({ operation: z.literal("releaseLocks"), ownerId: OwnerSchema }),
]);

export const FileSystemEntrySchema = z.object({
  path: PathSchema,
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().nonnegative(),
  modifiedAtMs: z.number(),
  isSymbolicLink: z.boolean(),
  etag: z.string(),
});

export const FileSystemLockSchema = z.object({
  path: PathSchema,
  token: z.string(),
  scope: z.enum(["exclusive", "shared"]),
  depth: z.enum(["0", "infinity"]),
  owner: z.string(),
  expiresAt: z.number(),
});

export const FileSystemInfoSchema = z.object({
  directory: PathSchema,
  pathStyle: z.enum(["posix", "windows"]),
  target: z.string(),
  commandExecution: z.boolean(),
});

export const FileSystemResultSchema = z.object({
  entry: FileSystemEntrySchema.nullable().optional(),
  entries: z.array(FileSystemEntrySchema).optional(),
  locks: z.array(FileSystemLockSchema).optional(),
  lock: FileSystemLockSchema.optional(),
  created: z.boolean().optional(),
  overwritten: z.boolean().optional(),
});

export const FileSystemReadQuerySchema = z.object({ path: PathSchema });
export type FileSystemCommand = z.infer<typeof FileSystemCommandSchema>;
export type FileSystemCommandInput = z.input<typeof FileSystemCommandSchema>;
export type FileSystemConditions = z.infer<typeof FileSystemConditionsSchema>;
export type FileSystemEntry = z.infer<typeof FileSystemEntrySchema>;
export type FileSystemLock = z.infer<typeof FileSystemLockSchema>;
export type FileSystemInfo = z.infer<typeof FileSystemInfoSchema>;
export type FileSystemResult = z.infer<typeof FileSystemResultSchema>;
