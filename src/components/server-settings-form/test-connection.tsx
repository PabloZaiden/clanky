/** Test connection button and result display. */

import { Button } from "../common";
import { CheckIcon, XIcon } from "./icons";

interface TestConnectionProps {
  onTest: () => Promise<void>;
  testing: boolean;
  disabled?: boolean;
  testResult: { success: boolean; error?: string } | null;
}

export function TestConnection({ onTest, testing, disabled = false, testResult }: TestConnectionProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onTest}
        loading={testing}
        disabled={disabled}
      >
        Test Connection
      </Button>

      {testResult && (
        <div className="flex items-center gap-2">
          {testResult.success ? (
            <>
              <CheckIcon className="w-5 h-5 text-green-500 flex-shrink-0" />
              <span className="text-sm text-green-600 dark:text-green-400">Connection successful</span>
            </>
          ) : (
            <>
              <XIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
              <span className="text-sm text-red-600 dark:text-red-400 break-words">
                {testResult.error ?? "Connection failed"}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
