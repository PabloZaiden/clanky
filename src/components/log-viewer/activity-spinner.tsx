interface ActivitySpinnerProps {
  className?: string;
}

export function ActivitySpinner({ className = "h-3.5 w-3.5" }: ActivitySpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent ${className}`}
    />
  );
}
