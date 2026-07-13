/**
 * App-specific button adapter for the framework button primitive.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button as FrameworkButton } from "@pablozaiden/webapp/web";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size variant */
  size?: ButtonSize;
  /** Whether the button is loading */
  loading?: boolean;
  /** Icon to display before the label */
  icon?: ReactNode;
  /** Children (label) */
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <FrameworkButton
      variant={variant === "secondary" ? "default" : variant}
      loading={loading}
      disabled={disabled || loading}
      className={`clanky-button-${size} ${className}`.trim()}
      {...props}
    >
      {!loading && icon ? (
        <span className="inline-flex">{icon}</span>
      ) : null}
      {children}
    </FrameworkButton>
  );
}

export default Button;
