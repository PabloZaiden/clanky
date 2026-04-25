import { describe, expect, mock, test } from "bun:test";
import { ModelSelector } from "@/components/ModelSelector";
import { renderWithUser } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";

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
});
