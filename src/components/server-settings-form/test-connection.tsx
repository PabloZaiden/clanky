/** Test connection action and result display. */

import { Button } from "../common";
import { FormGroup, SettingsFieldRow } from "@pablozaiden/webapp/web";

interface TestConnectionProps {
  layout: "fields" | "settings";
  onTest: () => Promise<void>;
  testing: boolean;
  disabled?: boolean;
  testResult: { success: boolean; error?: string } | null;
}

export function TestConnection({ layout, onTest, testing, disabled = false, testResult }: TestConnectionProps) {
  const feedback = testResult ? (
    <span role={testResult.success ? "status" : "alert"} className={testResult.success ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
      {testResult.success ? "Connected" : testResult.error ?? "Connection failed"}
    </span>
  ) : null;
  const action = (
    <Button
      type="button"
      size="sm"
      loading={testing}
      disabled={disabled || testing}
      onClick={() => void onTest()}
    >
      Test
    </Button>
  );
  return layout === "fields" ? (
    <FormGroup title="Connection">
      <div>{action}</div>
      {feedback}
    </FormGroup>
  ) : (
    <SettingsFieldRow title="Connection" feedback={feedback} actions={action} />
  );
}
