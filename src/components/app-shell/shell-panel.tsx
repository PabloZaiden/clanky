import type { InputHTMLAttributes } from "react";

export function ShellPanel({
  eyebrow: _eyebrow,
  title,
  description,
  descriptionClassName,
  actions,
  badges,
  variant = "card",
  bodyClassName,
  bodyContainerClassName,
  bodyContainerTestId,
  headerOffsetClassName,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  descriptionClassName?: string;
  actions?: React.ReactNode;
  badges?: React.ReactNode;
  variant?: "card" | "compact";
  bodyClassName?: string;
  bodyContainerClassName?: string;
  bodyContainerTestId?: string;
  headerOffsetClassName?: string;
  children: React.ReactNode;
}) {
  if (variant === "compact") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
        <div className="border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-neutral-800 sm:px-6 lg:px-8">
          <div
            className={[
              headerOffsetClassName ?? "ml-14 sm:ml-16 lg:ml-0",
              "flex min-h-14 flex-wrap items-center gap-1.5",
            ].join(" ")}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <h1 className="min-w-0 truncate text-base font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </h1>
              {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
              {description && (
                <span
                  className={[
                    "min-w-0 max-w-full truncate text-xs text-gray-500 dark:text-gray-400",
                    descriptionClassName ?? "",
                  ].join(" ").trim()}
                >
                  {description}
                </span>
              )}
            </div>
            {actions && <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">{actions}</div>}
          </div>
        </div>

        <div
          data-testid={bodyContainerTestId}
          className={bodyContainerClassName ?? "flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-5 pb-[calc(6rem+var(--safe-area-inset-bottom))] sm:px-6 sm:pb-5 lg:px-8 lg:py-6"}
        >
          <div className={bodyClassName ?? "space-y-6"}>
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-6 px-4 pb-5 pt-16 sm:px-6 sm:pt-20 lg:px-8 lg:pb-8 lg:pt-8">
      <div className="flex flex-col gap-4 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-neutral-900/80">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-100">{title}</h1>
                {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
              </div>
              {description && (
                <p className={["mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400", descriptionClassName ?? ""].join(" ").trim()}>
                  {description}
                </p>
              )}
            </div>
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function SummaryCard({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-2 overflow-hidden break-words [overflow-wrap:anywhere] text-2xl font-semibold text-gray-950 sm:text-3xl dark:text-gray-100">{value}</p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{meta}</p>
    </div>
  );
}

export function InlineField({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  disabled = false,
  help,
  inputProps,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  help?: string;
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        {...inputProps}
        className={`block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700${disabled ? " cursor-not-allowed bg-gray-100 dark:bg-neutral-900" : ""}`}
      />
      {help && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{help}</p>}
    </div>
  );
}
