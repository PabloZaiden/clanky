/**
 * Tests for the RenameChatModal component.
 */

import { describe, expect, mock, test } from "bun:test";
import { RenameChatModal } from "@/components/RenameChatModal";
import { act, renderWithUser, waitFor } from "../helpers/render";

describe("RenameChatModal", () => {
  const defaultProps = () => ({
    isOpen: true,
    onClose: mock(),
    currentName: "Repo pairing",
    onRename: mock(() => Promise.resolve()),
  });

  test("renders chat-specific title and label", () => {
    const { getByText, getByLabelText } = renderWithUser(
      <RenameChatModal {...defaultProps()} />,
    );

    expect(getByText("Rename Chat")).toBeInTheDocument();
    expect(getByLabelText("Chat Name")).toBeInTheDocument();
  });

  test("submits the trimmed chat name", async () => {
    const props = defaultProps();
    const { getByRole, getByLabelText, user } = renderWithUser(
      <RenameChatModal {...props} />,
    );

    const input = getByLabelText("Chat Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "  Renamed Chat  ");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onRename).toHaveBeenCalledWith("Renamed Chat");
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  test("shows validation feedback for an empty name", async () => {
    const { getByLabelText, getByText, user } = renderWithUser(
      <RenameChatModal {...defaultProps()} currentName="" />,
    );

    const input = getByLabelText("Chat Name") as HTMLInputElement;
    await user.type(input, "a");
    await user.clear(input);
    await user.type(input, " ");

    const form = input.closest("form");
    if (form) {
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    }

    await waitFor(() => {
      expect(getByText("Name cannot be empty")).toBeInTheDocument();
    });
  });

  test("shows rename failures inline", async () => {
    const props = defaultProps();
    props.onRename = mock(() => Promise.reject(new Error("Rename failed")));

    const { getByRole, getByLabelText, getByText, user } = renderWithUser(
      <RenameChatModal {...props} currentName="Old Name" />,
    );

    const input = getByLabelText("Chat Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "New Name");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getByText("Error: Rename failed")).toBeInTheDocument();
    });
  });
});
