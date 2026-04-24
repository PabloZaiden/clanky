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

  test("renders variants in the discovered order with parenthesized labels", () => {
    const { getAllByRole } = renderWithUser(
      <ModelSelector
        value=""
        onChange={() => {}}
        models={[
          {
            ...createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
            }),
            variants: ["medium", "low", "high", "xhigh"],
          },
        ]}
        ariaLabel="Model"
      />,
    );

    const options = getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "Select a model...",
      "GPT-5.4 (medium)",
      "GPT-5.4 (low)",
      "GPT-5.4 (high)",
      "GPT-5.4 (xhigh)",
    ]);
  });
});
