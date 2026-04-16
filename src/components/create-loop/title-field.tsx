import { Button } from "../common";

interface TitleFieldProps {
  name: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  canGenerate: boolean;
  generating: boolean;
}

export function TitleField({ name, onChange, onGenerate, canGenerate, generating }: TitleFieldProps) {
  return (
    <div>
      <label
        htmlFor="name"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Title
      </label>
      <div className="mt-1 flex items-start gap-2">
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Short loop title"
          maxLength={100}
          className="block flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onGenerate}
          disabled={!canGenerate}
          loading={generating}
          icon={<TitleSparkIcon className="h-4 w-4" />}
          aria-label="Generate title with AI"
          title="Generate title with AI"
          className="shrink-0 px-2"
        >
          {null}
        </Button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Optional. Give the loop a clear title, or let AI suggest one from the current prompt when you create it.
      </p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {name.trim().length}/100 characters
      </p>
    </div>
  );
}

function TitleSparkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
      />
    </svg>
  );
}
