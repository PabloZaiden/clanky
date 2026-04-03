import { describe, expect, test } from "bun:test";
import { DeleteSshServerSection } from "@/components/app-shell/delete-ssh-server-section";
import type { SshServer } from "@/types";
import { renderWithUser, waitFor, within } from "../helpers/render";

function createServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      repositoriesBasePath: "/workspaces",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "public-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

describe("DeleteSshServerSection", () => {
  test("keeps the confirmation modal open when deletion returns false", async () => {
    const { getByRole, getByText, queryByRole, user } = renderWithUser(
      <DeleteSshServerSection
        server={createServer()}
        relatedSessionCount={0}
        disabled={false}
        onDeleteServer={async () => false}
      />,
    );

    await user.click(getByRole("button", { name: "Delete SSH Server" }));

    await waitFor(() => {
      expect(getByRole("dialog")).toBeTruthy();
    });

    const dialog = getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete Server" }));

    await waitFor(() => {
      expect(getByText('Failed to delete SSH server "Build Box"')).toBeTruthy();
      expect(queryByRole("dialog")).toBeTruthy();
    });
  });
});
