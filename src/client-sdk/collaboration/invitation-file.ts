import { decodeWorkspaceInvitation } from "./proof";
import { downloadGeneratedFile } from "@/platform/web/download-generated-file";

const INVITATION_FILE_FORMAT = "clanky-workspace-invitation";
const MAX_INVITATION_FILE_BYTES = 72 * 1_024;

export async function readWorkspaceInvitationFile(file: File): Promise<string> {
  if (!file.size || file.size > MAX_INVITATION_FILE_BYTES) {
    throw new Error("Choose a Clanky invitation file no larger than 72 KiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("The invitation file could not be read as JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !("format" in value) || value.format !== INVITATION_FILE_FORMAT
    || !("version" in value) || value.version !== 1
    || !("invitation" in value) || typeof value.invitation !== "string") {
    throw new Error("The file is not a supported Clanky workspace invitation.");
  }
  await decodeWorkspaceInvitation(value.invitation);
  return value.invitation;
}

export function downloadWorkspaceInvitationFile(invitation: string, name?: string): void {
  const file = new Blob([JSON.stringify({
    format: INVITATION_FILE_FORMAT, version: 1, invitation,
  }, null, 2)], { type: "application/json" });
  if (file.size > MAX_INVITATION_FILE_BYTES) {
    throw new Error("The invitation file exceeds the 72 KiB limit.");
  }
  const filename = name?.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workspace";
  downloadGeneratedFile(file, `${filename}.clanky-invite.json`);
}
