import type {
  Agent,
  DeterministicAgentTestResult,
  DeterministicCodeDiagnostic,
} from "@/shared";
import { DETERMINISTIC_AGENT_CODE_CONTRACT, DETERMINISTIC_AGENT_CODE_EXAMPLE } from "@/shared/deterministic-agent";
import type { TaskLogEntry } from "@/shared/task";
import { Button, StatusBadge } from "../common";
import { ChatDetails } from "../ChatDetails";
import { MonacoCodeEditor } from "../MonacoCodeEditor";
import type { UseAgentCodeGenerationResult } from "./use-agent-code-generation";
import type { UseAgentCodeTestResult } from "./use-agent-code-test";
import type { AgentFormMode } from "./use-agent-form-state";

export interface AgentDeterministicModeProps {
  mode: AgentFormMode;
  agent: Agent | null;
  isSubmitting: boolean;
  canGenerateCode: boolean;
  canTestCode: boolean;
  generation: UseAgentCodeGenerationResult;
  testing: UseAgentCodeTestResult;
}

export function AgentDeterministicMode({
  mode,
  agent,
  isSubmitting,
  canGenerateCode,
  canTestCode,
  generation,
  testing,
}: AgentDeterministicModeProps) {
  return (
    <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Deterministic Mode (optional)</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Deterministic Mode code replaces the scheduled prompt. Leave it empty to keep prompt mode
        </p>
      </div>
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
        <p className="font-medium">Code contract</p>
        <p className="mt-1">{DETERMINISTIC_AGENT_CODE_CONTRACT.exportRule} {DETERMINISTIC_AGENT_CODE_CONTRACT.asyncRule}</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li><code>{DETERMINISTIC_AGENT_CODE_CONTRACT.exec}</code></li>
          <li><code>{DETERMINISTIC_AGENT_CODE_CONTRACT.prompt}</code></li>
          <li><code>{DETERMINISTIC_AGENT_CODE_CONTRACT.output}</code></li>
          <li><code>{DETERMINISTIC_AGENT_CODE_CONTRACT.signal}</code></li>
        </ul>
        <div className="mt-3">
          <p className="font-medium">Minimal valid example</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-white px-3 py-2 font-mono text-[11px] leading-5 text-gray-900 dark:bg-neutral-900 dark:text-gray-100">
            <code>{DETERMINISTIC_AGENT_CODE_EXAMPLE}</code>
          </pre>
        </div>
      </div>
      <div>
        <label htmlFor="agent-code" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          TypeScript code
        </label>
        <div
          id="agent-code"
          aria-label="TypeScript code"
          className="mt-1 min-h-72 overflow-hidden rounded-md border border-gray-300 dark:border-gray-600"
        >
          <MonacoCodeEditor
            height="360px"
            language="typescript"
            value={generation.code}
            ariaLabel="TypeScript code editor"
            onChange={generation.setCode}
          />
        </div>
        {/* Monaco owns the editable code surface; keep diagnostics outside its model. */}
        {generation.codeDiagnostics.length > 0 && (
          <div className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
            {generation.codeDiagnostics.map((diagnostic, index) => (
              <CodeDiagnostic key={`${diagnostic.line ?? "code"}-${diagnostic.column ?? "position"}-${index}`} diagnostic={diagnostic} />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-28"
          onClick={() => void generation.generateCode()}
          disabled={isSubmitting || !canGenerateCode}
          loading={generation.isGeneratingCode}
        >
          Generate
        </Button>
        {generation.isGeneratingCode && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={generation.cancelGeneration}
          >
            Cancel generation
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-28"
          onClick={() => void testing.testCode()}
          disabled={isSubmitting || !canTestCode}
          loading={testing.isTestingCode}
        >
          Test
        </Button>
        {testing.isTestingCode && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={testing.cancelTest}
          >
            Cancel test
          </Button>
        )}
      </div>
      {mode === "edit" && agent && generation.generationChatId ? (
        <div className="h-[min(38rem,70vh)] min-h-[24rem] overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
          <ChatDetails
            key={generation.generationChatId}
            chatId={generation.generationChatId}
            embedded
            showBackButton={false}
            isExternallyBusy={generation.isGeneratingCode}
            onSendMessage={generation.sendGenerationMessage}
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          Save the agent, then use Generate to start its persistent code-generation conversation.
        </p>
      )}
      {(testing.isTestingCode || testing.testResult || testing.testLogs.length > 0) && (
        <DeterministicTestOutputPanel
          result={testing.testResult}
          logs={testing.testLogs}
          isRunning={testing.isTestingCode}
        />
      )}
    </section>
  );
}

function CodeDiagnostic({ diagnostic }: { diagnostic: DeterministicCodeDiagnostic }) {
  return (
    <p>
      {diagnostic.line ? `Line ${diagnostic.line}: ` : ""}{diagnostic.message}
    </p>
  );
}

function DeterministicTestOutputPanel({
  result,
  logs,
  isRunning,
}: {
  result: DeterministicAgentTestResult | null;
  logs: TaskLogEntry[];
  isRunning: boolean;
}) {
  return (
    <section className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Test output</h2>
        <StatusBadge
          variant={
            isRunning
              ? "info"
              : result?.status === "completed"
                ? "success"
                : result?.status === "cancelled"
                  ? "warning"
                  : "error"
          }
          size="sm"
        >
          {isRunning ? "running" : result?.status ?? "failed"}
        </StatusBadge>
      </div>
      {result?.error && (
        <p className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">{result.error}</p>
      )}
      {result && result.diagnostics.length > 0 && (
        <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
          {result.diagnostics.map((diagnostic, index) => (
            <CodeDiagnostic
              key={`${diagnostic.line ?? "code"}-${diagnostic.column ?? "position"}-${index}`}
              diagnostic={diagnostic}
            />
          ))}
        </div>
      )}
      <DeterministicOutputStreams logs={logs} />
    </section>
  );
}

function DeterministicOutputStreams({ logs }: { logs: TaskLogEntry[] }) {
  const outputLogs = logs.filter((log) => {
    const stream = log.details?.["stream"];
    return stream === "stdout" || stream === "stderr";
  });

  const renderStream = (stream: "stdout" | "stderr") => outputLogs
    .filter((log) => log.details?.["stream"] === stream)
    .map((log) => log.message)
    .join("");

  const stdout = renderStream("stdout");
  const stderr = renderStream("stderr");
  return (
    <div className="grid gap-3 rounded-md border border-gray-200 bg-neutral-950 p-3 text-xs text-gray-100 dark:border-gray-700">
      <div className="min-w-0">
        <h2 className="font-semibold text-gray-300">stdout</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{stdout || "(empty)"}</pre>
      </div>
      <div className="min-w-0">
        <h2 className="font-semibold text-red-300">stderr</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-red-100">{stderr || "(empty)"}</pre>
      </div>
    </div>
  );
}
