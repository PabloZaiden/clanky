import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { CheckboxField, Input, Select } from "@pablozaiden/webapp/web";

export function SettingsSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <Select {...props} />;
}

export function SettingsInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <Input {...props} />;
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
      <CheckboxField {...props} label="" aria-label={ariaLabel} />
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
