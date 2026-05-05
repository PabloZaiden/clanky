import { describe, expect, mock, test } from "bun:test";
import { getPreferredModelVariant, ModelSelector } from "@/components/ModelSelector";
import { renderWithUser } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";

function getModelOptionValues(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options)
    .map((option) => option.value)
    .filter((value) => value.length > 0);
}

describe("ModelSelector", () => {
  test("calls onChange with the selected variant key", async () => {
    const onChange = mock();
    const { getByRole, user } = renderWithUser(
      <ModelSelector
        value=""
        onChange={onChange}
        models={[
          {
            ...createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
            }),
            variants: ["medium", "high"],
          },
        ]}
        ariaLabel="Model"
      />,
    );

    await user.selectOptions(getByRole("combobox", { name: "Model" }), "copilot:gpt-5.4:high");
    expect(onChange).toHaveBeenCalledWith("copilot:gpt-5.4:high");
  });

  test("orders recognized reasoning effort variants by effort", () => {
    const { getByRole } = renderWithUser(
      <ModelSelector
        value=""
        onChange={mock()}
        models={[
          {
            ...createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
            }),
            variants: ["xhigh", "high", "low", "medium"],
          },
        ]}
        ariaLabel="Model"
      />,
    );

    expect(getModelOptionValues(getByRole("combobox", { name: "Model" }))).toEqual([
      "copilot:gpt-5.4:low",
      "copilot:gpt-5.4:medium",
      "copilot:gpt-5.4:high",
      "copilot:gpt-5.4:xhigh",
    ]);
  });

  test("orders unknown variants lexicographically", () => {
    const { getByRole } = renderWithUser(
      <ModelSelector
        value=""
        onChange={mock()}
        models={[
          {
            ...createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "custom-reasoning",
              modelName: "Custom Reasoning",
            }),
            variants: ["zeta", "alpha", "beta"],
          },
        ]}
        ariaLabel="Model"
      />,
    );

    expect(getModelOptionValues(getByRole("combobox", { name: "Model" }))).toEqual([
      "copilot:custom-reasoning:alpha",
      "copilot:custom-reasoning:beta",
      "copilot:custom-reasoning:zeta",
    ]);
  });

  test("fallback variant selection preserves backend-provided priority", () => {
    expect(
      getPreferredModelVariant(
        [
          {
            ...createModelInfo({
              providerID: "copilot",
              modelID: "gpt-5.4",
            }),
            variants: ["high", "low", "medium"],
          },
        ],
        "copilot",
        "gpt-5.4",
        "missing",
      ),
    ).toBe("high");
  });
});
