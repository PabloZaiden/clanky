import { describe, expect, test } from "bun:test";
import { ModelSelector } from "@/components/ModelSelector";
import { renderWithUser } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";

describe("ModelSelector", () => {
  test("passes through an aria-label to the underlying select", () => {
    const { getByRole } = renderWithUser(
      <ModelSelector
        value=""
        onChange={() => {}}
        models={[createModelInfo()]}
        ariaLabel="Model"
      />,
    );

    expect(getByRole("combobox", { name: "Model" })).toBeInTheDocument();
  });
});
