/**
 * Tests for the MarkdownRenderer component.
 */

import { describe, expect, test } from "bun:test";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { renderWithUser } from "../helpers/render";

describe("MarkdownRenderer", () => {
  test("wraps raw markdown content instead of enabling horizontal scrolling on the outer text block", () => {
    const { container } = renderWithUser(
      <MarkdownRenderer
        content={"AReallyLongTokenWithoutSpacesThatShouldWrapInRawMode"}
        rawMode={true}
      />
    );

    const pre = container.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("break-words");
    expect(pre?.className).not.toContain("overflow-x-auto");
  });

  test("adds wrapping helpers to rendered markdown containers and inline code", () => {
    const { container } = renderWithUser(
      <MarkdownRenderer content={"Paragraph with `AReallyLongInlineCodeToken` inside."} />
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("markdown-renderer");
    expect(wrapper.className).toContain("min-w-0");
    expect(wrapper.className).toContain("break-words");

    const inlineCode = container.querySelector("code");
    expect(inlineCode).toBeInTheDocument();
    expect(inlineCode?.className).toContain("break-all");
  });
});
