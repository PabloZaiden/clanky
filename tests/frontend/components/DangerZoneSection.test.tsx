import { describe, expect, mock, test } from "bun:test";
import { DangerZoneSection } from "@/components/app-settings/danger-zone-section";
import { renderWithUser } from "../helpers/render";

describe("DangerZoneSection", () => {
  test("uses section-level spacing when reset and remove-passkey actions are stacked", async () => {
    const { getByRole, user } = renderWithUser(
      <DangerZoneSection
        onResetAll={mock(async () => true)}
        onKillServer={mock(async () => true)}
        passkeyConfigured
        onRemovePasskey={mock(async () => true)}
      />,
    );

    await user.click(getByRole("button", { name: /Danger Zone/ }));

    const toggleButton = getByRole("button", { name: /Danger Zone/ });
    const removePasskeyButton = getByRole("button", { name: "Remove passkey" });
    expect(removePasskeyButton).toBeInTheDocument();

    const dangerZoneCard = toggleButton.parentElement;
    expect(dangerZoneCard).not.toBeNull();
    if (!dangerZoneCard) {
      throw new Error("Expected the Danger Zone toggle button to be inside its card container.");
    }

    const expandedSections = dangerZoneCard.querySelector("div.mt-4.space-y-4");
    expect(expandedSections).toBeInTheDocument();

    const resetSection = getByRole("button", { name: "Reset all settings" }).parentElement;
    expect(resetSection).not.toBeNull();
    if (!resetSection) {
      throw new Error("Expected the reset action button to be inside its section container.");
    }

    expect(resetSection).toHaveClass("space-y-3");
  });
});
