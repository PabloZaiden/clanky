interface ComposerInterruptButtonProps {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel: string;
}

export function ComposerInterruptButton({
  onClick,
  disabled = false,
  busy = false,
  ariaLabel,
}: ComposerInterruptButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="clanky-composer-interrupt-button wapp-action-menu-trigger wapp-action-menu-trigger-compact flex-shrink-0"
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-busy={busy || undefined}
    >
      {busy ? (
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        <span className="text-lg leading-none" aria-hidden="true">×</span>
      )}
    </button>
  );
}
