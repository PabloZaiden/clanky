export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export const SECRET_MAX_BYTES = 64 * 1024;
export const SECRET_TOOL_NAME = "clanky_request_secret";

export interface SecretFileReference {
  path: string;
  expiresAt: number;
}

export type SecretFileResult =
  | ({ status: "saved" } & SecretFileReference)
  | { status: "declined" };
