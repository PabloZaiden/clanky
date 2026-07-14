import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const SELECT_CLASS_NAME = "block w-full max-w-xl rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600";
const CHECKBOX_CLASS_NAME = "mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:focus:ring-gray-600";

export function SettingsSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...selectProps } = props;
  return <select {...selectProps} className={`${SELECT_CLASS_NAME} ${className}`.trim()} />;
}

export function SettingsCheckbox({
  ariaLabel,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  ariaLabel: string;
  error?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <input
        {...props}
        type="checkbox"
        aria-label={ariaLabel}
        className={`${CHECKBOX_CLASS_NAME} ${props.className ?? ""}`.trim()}
      />
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}

export function SettingsError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}
