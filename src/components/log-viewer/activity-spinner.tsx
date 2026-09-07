interface ActivitySpinnerProps {
  className?: string;
  label?: string;
}

export function ActivitySpinner({
  className = "h-3.5 w-3.5",
  label,
}: ActivitySpinnerProps) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`inline-block shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent ${className}`}
      />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}
