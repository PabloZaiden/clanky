import { describe, expect, mock, test } from "bun:test";
import { DangerZoneSection } from "@/components/app-settings/danger-zone-section";
import { renderWithUser } from "../helpers/render";

describe("DangerZoneSection", () => {
  test("reveals destructive actions when expanded", async () => {
    const { getByRole, user } = renderWithUser(
      <DangerZoneSection
        onResetAll={mock(async () => true)}
        onKillServer={mock(async () => true)}
        passkeyConfigured
        onRemovePasskey={mock(async () => true)}
      />,
    );

    await user.click(getByRole("button", { name: /Danger Zone/ }));

    expect(getByRole("button", { name: "Reset all settings" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Remove passkey" })).toBeInTheDocument();
  });
});
