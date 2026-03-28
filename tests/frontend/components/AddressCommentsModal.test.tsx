/**
 * Tests for the AddressCommentsModal component.
 */

import { test, expect, describe } from "bun:test";
import { mock } from "bun:test";
import { AddressCommentsModal } from "@/components/AddressCommentsModal";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";

installImageAttachmentMocks();

describe("AddressCommentsModal", () => {
  const defaultProps = () => ({
    isOpen: true,
    onClose: mock(),
    onSubmit: mock(() => Promise.resolve()),
    loopName: "Test Loop",
    reviewCycle: 1,
  });

  describe("rendering", () => {
    test("renders modal title", () => {
      const { getByText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByText("Address Reviewer Comments")).toBeInTheDocument();
    });

    test("renders description with loop name and review cycle", () => {
      const { getByText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} loopName="My Loop" reviewCycle={3} />
      );
      expect(getByText('Submit feedback for "My Loop" (Review Cycle 3)')).toBeInTheDocument();
    });

    test("renders textarea for comments", () => {
      const { getByLabelText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByLabelText("Reviewer Comments")).toBeInTheDocument();
    });

    test("renders textarea with placeholder", () => {
      const { getByPlaceholderText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByPlaceholderText(/Enter your review comments here/)).toBeInTheDocument();
    });

    test("renders Cancel and Submit Comments buttons", () => {
      const { getByRole } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(getByRole("button", { name: "Insert PR review prompt" })).toBeInTheDocument();
      expect(getByRole("button", { name: "Submit Comments" })).toBeInTheDocument();
    });

    test("renders help text about loop behavior", () => {
      const { getByText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByText(/The loop will restart and address these comments/)).toBeInTheDocument();
    });
  });

  describe("not rendered when closed", () => {
    test("does not render content when isOpen is false", () => {
      const { queryByText } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} isOpen={false} />
      );
      expect(queryByText("Address Reviewer Comments")).not.toBeInTheDocument();
    });
  });

  describe("validation", () => {
    test("Submit Comments button is disabled when textarea is empty", () => {
      const { getByRole } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Submit Comments" })).toBeDisabled();
    });

    test("Submit Comments button is disabled when textarea has only whitespace", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "   ");
      expect(getByRole("button", { name: "Submit Comments" })).toBeDisabled();
    });

    test("Submit Comments button is enabled when textarea has content", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "Fix the bug");
      expect(getByRole("button", { name: "Submit Comments" })).not.toBeDisabled();
    });
  });

  describe("submission", () => {
    test("inserts the canned PR review prompt into the textarea", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );

      await user.click(getByRole("button", { name: "Insert PR review prompt" }));

      expect(getByLabelText("Reviewer Comments")).toHaveValue(
        "Find the PR associated to this branch and address the unresolved comments",
      );
    });

    test("appends the canned PR review prompt without duplicating it", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...defaultProps()} />
      );

      const textarea = getByLabelText("Reviewer Comments");
      await user.type(textarea, "Please also verify CI");
      await user.click(getByRole("button", { name: "Insert PR review prompt" }));
      await user.click(getByRole("button", { name: "Insert PR review prompt" }));

      expect(textarea).toHaveValue(
        "Please also verify CI\n\nFind the PR associated to this branch and address the unresolved comments",
      );
    });

    test("calls onSubmit with comment text on submit", async () => {
      const props = defaultProps();
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...props} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "Please fix the error handling");
      await user.click(getByRole("button", { name: "Submit Comments" }));
      expect(props.onSubmit).toHaveBeenCalledWith("Please fix the error handling");
    });

    test("submits pasted image attachments with the comment", async () => {
      const props = defaultProps();
      const { getByRole, getByLabelText, getByText, user } = renderWithUser(
        <AddressCommentsModal {...props} />
      );

      const textarea = getByLabelText("Reviewer Comments");
      await user.type(textarea, "Please fix the UI");
      pasteFiles(textarea, [createTestFile({ name: "review.png" })]);

      await waitFor(() => {
        expect(getByText("review.png")).toBeInTheDocument();
      });

      await user.click(getByRole("button", { name: "Submit Comments" }));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      expect(props.onSubmit).toHaveBeenCalledWith(
        "Please fix the UI",
        expect.arrayContaining([
          expect.objectContaining({
            filename: "review.png",
            mimeType: "image/png",
          }),
        ]),
      );
    });

    test("calls onClose after successful submission", async () => {
      const props = defaultProps();
      const { getByRole, getByLabelText, user } = renderWithUser(
        <AddressCommentsModal {...props} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "Fix it");
      await user.click(getByRole("button", { name: "Submit Comments" }));
      await waitFor(() => {
        expect(props.onClose).toHaveBeenCalled();
      });
    });

    test("keeps modal open on submission error", async () => {
      const props = defaultProps();
      props.onSubmit = mock(() => Promise.reject(new Error("Network error")));
      const { getByRole, getByLabelText, getByText, user } = renderWithUser(
        <AddressCommentsModal {...props} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "Fix it");
      await user.click(getByRole("button", { name: "Submit Comments" }));
      // Modal should still be visible (onClose not called)
      await waitFor(() => {
        expect(getByText("Address Reviewer Comments")).toBeInTheDocument();
      });
      expect(props.onClose).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    test("calls onClose when Cancel button clicked", async () => {
      const props = defaultProps();
      const { getByRole, user } = renderWithUser(
        <AddressCommentsModal {...props} />
      );
      await user.click(getByRole("button", { name: "Cancel" }));
      expect(props.onClose).toHaveBeenCalled();
    });

    test("clears comments when Cancel is clicked", async () => {
      const props = defaultProps();
      const { getByRole, getByLabelText, user, rerender } = renderWithUser(
        <AddressCommentsModal {...props} />
      );
      await user.type(getByLabelText("Reviewer Comments"), "Some text");
      await user.click(getByRole("button", { name: "Cancel" }));
      // Re-render to simulate modal reopening
      rerender(<AddressCommentsModal {...props} />);
      const textarea = getByLabelText("Reviewer Comments") as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
    });
  });
});
