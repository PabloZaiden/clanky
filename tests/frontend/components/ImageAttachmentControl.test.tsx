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

function AttachmentPasteHarness() {
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
        iconOnly
      />
    </div>
  );
}

describe("ImageAttachmentControl", () => {
  test("adds an attachment when an image is pasted into the host field", async () => {
    const { getByLabelText, getByText } = renderWithUser(<AttachmentPasteHarness />);

    pasteFiles(getByLabelText("Message"), [createTestFile()]);

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

  test("enforces the attachment limit across repeated pastes", async () => {
    const { getByLabelText, getByText } = renderWithUser(<AttachmentPasteHarness />);
    const textarea = getByLabelText("Message");

    for (let index = 0; index < MESSAGE_IMAGE_ATTACHMENT_LIMIT; index += 1) {
      const filename = `image-${index + 1}.png`;
      pasteFiles(textarea, [createTestFile({ name: filename })]);

      await waitFor(() => {
        expect(getByText(filename)).toBeInTheDocument();
      });
    }

    pasteFiles(textarea, [createTestFile({ name: "image-4.png" })]);

    await waitFor(() => {
      expect(getByText(/You can attach up to 3 images at a time/i)).toBeInTheDocument();
    });
  });
});
