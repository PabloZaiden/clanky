import { describe, expect, test } from "bun:test";
import { ModelSelector } from "@/components/ModelSelector";
import { renderWithUser } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";

describe("ModelSelector", () => {
  test("adds compact mobile overlay state classes for disabled and focus-visible states", () => {
    const { container } = renderWithUser(
      <ModelSelector
        value=""
        onChange={() => {}}
        models={[createModelInfo()]}
        compactMobile
        disabled
        className="h-9 w-9 rounded-md"
      />,
    );

    const select = container.querySelector("select");
    const overlay = container.querySelector("[aria-hidden='true']");

    expect(select).toBeInTheDocument();
    expect(select?.className).toContain("peer");
    expect(overlay).toBeInTheDocument();
    expect(overlay?.className).toContain("peer-disabled:border-gray-200");
    expect(overlay?.className).toContain("peer-focus-visible:ring-2");
  });

  test("keeps the compact trigger active on larger screens", () => {
    const { container } = renderWithUser(
      <ModelSelector
        value=""
        onChange={() => {}}
        models={[createModelInfo()]}
        compactMobile
        className="h-9 w-9 rounded-md"
      />,
    );

    const wrapper = container.firstElementChild;
    const select = container.querySelector("select");
    const overlay = container.querySelector("[aria-hidden='true']");

    expect(wrapper?.className).toContain("h-9 w-9");
    expect(wrapper?.className).not.toContain("sm:h-auto");
    expect(select?.className).not.toContain("sm:static");
    expect(overlay?.className).not.toContain("sm:hidden");
  });
});
