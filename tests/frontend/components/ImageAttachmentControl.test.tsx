import { describe, expect, test } from "bun:test";
import { useRef, useState, type ClipboardEvent } from "react";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "@/components/ImageAttachmentControl";
import type { ComposerImageAttachment } from "@/types/message-attachments";
import { MESSAGE_IMAGE_ATTACHMENT_LIMIT } from "@/types/message-attachments";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";

installImageAttachmentMocks();

interface AttachmentPasteHarnessProps {
  disabled?: boolean;
}

function AttachmentPasteHarness({ disabled = false }: AttachmentPasteHarnessProps) {
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [message, setMessage] = useState("");
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  return (
    <div>
      <textarea
        aria-label="Message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onPaste={handlePaste}
      />
      <ImageAttachmentControl
        ref={attachmentControlRef}
        attachments={attachments}
        onChange={setAttachments}
        disabled={disabled}
        iconOnly
      />
    </div>
  );
}

describe("ImageAttachmentControl", () => {
  test("adds an attachment when an image is pasted into the host field", async () => {
    const { getByLabelText, getByText } = renderWithUser(<AttachmentPasteHarness />);

    const pasteResult = pasteFiles(getByLabelText("Message"), [createTestFile()]);

    expect(pasteResult).toBe(false);

    await waitFor(() => {
      expect(getByText("clipboard-image.png")).toBeInTheDocument();
    });
  });

  test("keeps normal text paste behavior when no image is present", async () => {
    const { getByLabelText, user } = renderWithUser(<AttachmentPasteHarness />);

    const textarea = getByLabelText("Message");
    await user.click(textarea);
    await user.paste("Pasted text");

    expect(textarea).toHaveValue("Pasted text");
  });

  test("shows an error for unsupported pasted image types", async () => {
    const { getByLabelText, getByText } = renderWithUser(<AttachmentPasteHarness />);

    pasteFiles(getByLabelText("Message"), [
      createTestFile({ name: "clipboard-image.svg", type: "image/svg+xml" }),
    ]);

    await waitFor(() => {
      expect(getByText(/clipboard-image\.svg is not a supported image type/i)).toBeInTheDocument();
    });
  });

  test("ignores pasted images when the control is disabled", async () => {
    const { getByLabelText, queryByText } = renderWithUser(<AttachmentPasteHarness disabled />);

    const pasteResult = pasteFiles(getByLabelText("Message"), [createTestFile()]);

    expect(pasteResult).toBe(true);

    await waitFor(() => {
      expect(queryByText("clipboard-image.png")).not.toBeInTheDocument();
    });
  });

  test("enforces the attachment limit across repeated pastes", async () => {
    const { getByLabelText, getByText } = renderWithUser(<AttachmentPasteHarness />);
    const textarea = getByLabelText("Message");
    const overLimitFilename = `image-${MESSAGE_IMAGE_ATTACHMENT_LIMIT + 1}.png`;

    for (let index = 0; index < MESSAGE_IMAGE_ATTACHMENT_LIMIT; index += 1) {
      const filename = `image-${index + 1}.png`;
      pasteFiles(textarea, [createTestFile({ name: filename })]);

      await waitFor(() => {
        expect(getByText(filename)).toBeInTheDocument();
      });
    }

    pasteFiles(textarea, [createTestFile({ name: overLimitFilename })]);

    await waitFor(() => {
      expect(
        getByText(new RegExp(`You can attach up to ${MESSAGE_IMAGE_ATTACHMENT_LIMIT} images at a time`, "i")),
      ).toBeInTheDocument();
    });
  });

  test("opens and closes a larger preview when an attachment thumbnail is clicked", async () => {
    const { getByLabelText, getByRole, queryByRole, user } = renderWithUser(<AttachmentPasteHarness />);

    pasteFiles(getByLabelText("Message"), [createTestFile()]);

    await waitFor(() => {
      expect(getByLabelText("View clipboard-image.png")).toBeInTheDocument();
    });

    await user.click(getByLabelText("View clipboard-image.png"));

    await waitFor(() => {
      expect(getByRole("dialog", { name: "clipboard-image.png" })).toBeInTheDocument();
    });

    await user.click(getByLabelText("Close"));

    await waitFor(() => {
      expect(queryByRole("dialog", { name: "clipboard-image.png" })).not.toBeInTheDocument();
    });
  });
});
