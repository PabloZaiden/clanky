/**
 * Tests for the Modal and ConfirmModal components.
 */

import { test, expect, describe, mock } from "bun:test";
import { Modal, ConfirmModal } from "@/components/common/Modal";
import { renderWithUser } from "../../helpers/render";

describe("Modal", () => {
  describe("visibility", () => {
    test("renders nothing when isOpen is false", () => {
      const { queryByRole } = renderWithUser(
        <Modal isOpen={false} onClose={() => {}} title="Test Modal">
          <p>Content</p>
        </Modal>
      );
      expect(queryByRole("dialog")).not.toBeInTheDocument();
    });

  });

  describe("close button", () => {
    test("calls onClose when close button is clicked", async () => {
      const onClose = mock(() => {});
      const { user, getByLabelText } = renderWithUser(
        <Modal isOpen={true} onClose={onClose} title="Title">
          <p>Content</p>
        </Modal>
      );

      await user.click(getByLabelText("Close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("does not submit an enclosing form when the close button is clicked", async () => {
      const onClose = mock(() => {});
      const onSubmit = mock(() => {});
      const { user, getByLabelText } = renderWithUser(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <Modal isOpen={true} onClose={onClose} title="Title">
            <p>Content</p>
          </Modal>
        </form>
      );

      await user.click(getByLabelText("Close"));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("escape key", () => {
    test("calls onClose on Escape key press", async () => {
      const onClose = mock(() => {});
      const { user } = renderWithUser(
        <Modal isOpen={true} onClose={onClose} title="Title">
          <p>Content</p>
        </Modal>
      );

      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("overlay click", () => {
    test("calls onClose when overlay is clicked (default)", async () => {
      const onClose = mock(() => {});
      const { user } = renderWithUser(
        <Modal isOpen={true} onClose={onClose} title="Title">
          <p>Content</p>
        </Modal>
      );

      // The overlay has aria-hidden="true"
      const overlay = document.querySelector("[aria-hidden='true']");
      expect(overlay).not.toBeNull();
      await user.click(overlay!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("does not call onClose when closeOnOverlayClick is false", async () => {
      const onClose = mock(() => {});
      const { user } = renderWithUser(
        <Modal
          isOpen={true}
          onClose={onClose}
          title="Title"
          closeOnOverlayClick={false}
        >
          <p>Content</p>
        </Modal>
      );

      const overlay = document.querySelector("[aria-hidden='true']");
      expect(overlay).not.toBeNull();
      await user.click(overlay!);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("accessibility", () => {
    test("only closes the topmost modal on Escape", async () => {
      const firstOnClose = mock(() => {});
      const secondOnClose = mock(() => {});
      const { user } = renderWithUser(
        <>
          <Modal isOpen={true} onClose={firstOnClose} title="First modal">
            <p>First content</p>
          </Modal>
          <Modal isOpen={true} onClose={secondOnClose} title="Second modal">
            <p>Second content</p>
          </Modal>
        </>
      );

      await user.keyboard("{Escape}");

      expect(firstOnClose).not.toHaveBeenCalled();
      expect(secondOnClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ConfirmModal", () => {
  test("calls onConfirm when confirm button is clicked", async () => {
    const onConfirm = mock(() => {});
    const { user, getByRole } = renderWithUser(
      <ConfirmModal
        isOpen={true}
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Confirm Action"
        message="Sure?"
      />
    );

    await user.click(getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("calls onClose when cancel button is clicked", async () => {
    const onClose = mock(() => {});
    const { user, getByText } = renderWithUser(
      <ConfirmModal
        isOpen={true}
        onClose={onClose}
        onConfirm={() => {}}
        title="Confirm"
        message="Sure?"
      />
    );

    await user.click(getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("disables cancel button when loading", () => {
    const { getByText } = renderWithUser(
      <ConfirmModal
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
        title="Confirm"
        message="Sure?"
        loading={true}
      />
    );

    const cancelBtn = getByText("Cancel").closest("button");
    expect(cancelBtn).toBeDisabled();
  });
});
