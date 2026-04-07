import { describe, expect, mock, test } from "bun:test";
import { RenameLoopModal } from "@/components/RenameLoopModal";
import { act, renderWithUser, waitFor } from "../helpers/render";

describe("RenameLoopModal", () => {
  const defaultProps = () => ({
    isOpen: true,
    onClose: mock(),
    currentName: "My Loop",
    onRename: mock(() => Promise.resolve()),
  });

  test("does not render when closed", () => {
    const { queryByText } = renderWithUser(
      <RenameLoopModal {...defaultProps()} isOpen={false} />,
    );

    expect(queryByText("Rename Loop")).not.toBeInTheDocument();
  });

  test("submits a trimmed renamed value and closes", async () => {
    const props = defaultProps();
    const { getByLabelText, getByRole, user } = renderWithUser(
      <RenameLoopModal {...props} />,
    );

    const input = getByLabelText("Loop Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "  Renamed Loop  ");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onRename).toHaveBeenCalledWith("Renamed Loop");
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  test("closes without renaming when the trimmed name is unchanged", async () => {
    const props = defaultProps();
    const { getByRole, user } = renderWithUser(
      <RenameLoopModal {...props} currentName="Same Name" />,
    );

    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  test("shows validation feedback for an empty name", async () => {
    const { getByLabelText, getByText, user } = renderWithUser(
      <RenameLoopModal {...defaultProps()} currentName="" />,
    );

    const input = getByLabelText("Loop Name") as HTMLInputElement;
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

  test("clears a rename error after the user edits the name", async () => {
    const props = defaultProps();
    props.onRename = mock(() => Promise.reject(new Error("Rename failed")));

    const { getByLabelText, getByRole, getByText, queryByText, user } = renderWithUser(
      <RenameLoopModal {...props} currentName="Old Loop" />,
    );

    const input = getByLabelText("Loop Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "New Loop");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getByText("Error: Rename failed")).toBeInTheDocument();
    });

    await user.type(input, "x");
    expect(queryByText("Error: Rename failed")).not.toBeInTheDocument();
  });
});
