import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import {
  ImageViewerModal,
  type ImageViewerModalImage,
} from "@/components/ImageViewerModal";
import { renderWithUser, waitFor } from "../helpers/render";

const TEST_IMAGE: ImageViewerModalImage = {
  src: "data:image/png;base64,ZmFrZQ==",
  alt: "screen.png",
  title: "screen.png",
  description: "2 KB",
};

interface ImageViewerModalFormHarnessProps {
  onSubmit: () => void;
}

function ImageViewerModalFormHarness({ onSubmit }: ImageViewerModalFormHarnessProps) {
  const [image, setImage] = useState<ImageViewerModalImage | null>(TEST_IMAGE);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <button type="submit">Submit form</button>
      <ImageViewerModal image={image} onClose={() => setImage(null)} />
    </form>
  );
}

describe("ImageViewerModal", () => {
  test("does not submit an enclosing form when the header close button is clicked", async () => {
    const onSubmit = mock(() => {});
    const { getByLabelText, queryByRole, user } = renderWithUser(
      <ImageViewerModalFormHarness onSubmit={onSubmit} />
    );

    await user.click(getByLabelText("Close"));

    await waitFor(() => {
      expect(queryByRole("dialog", { name: "screen.png" })).not.toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("does not submit an enclosing form when the footer close button is clicked", async () => {
    const onSubmit = mock(() => {});
    const { getByText, queryByRole, user } = renderWithUser(
      <ImageViewerModalFormHarness onSubmit={onSubmit} />
    );

    await user.click(getByText("Close").closest("button")!);

    await waitFor(() => {
      expect(queryByRole("dialog", { name: "screen.png" })).not.toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
