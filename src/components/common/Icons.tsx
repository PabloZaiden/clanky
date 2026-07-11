/**
 * Reusable SVG icon components.
 */

export interface IconProps {
  /** CSS class name */
  className?: string;
  /** Icon size in Tailwind format (e.g., "h-4 w-4") */
  size?: string;
}

/**
 * Code/code-explorer icon for source browsing actions.
 */
export function CodeIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"
      />
    </svg>
  );
}

export function ChatIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 8h10M7 12h6m-8 8 3.5-3.5H18a3 3 0 003-3V7a3 3 0 00-3-3H6a3 3 0 00-3 3v6.5a3 3 0 003 3h.5L5 20z"
      />
    </svg>
  );
}

/**
 * Edit/Pencil icon for rename and edit actions.
 */
export function EditIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
      />
    </svg>
  );
}

/**
 * Grid icon for card view mode toggle.
 */
export function GridIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
      />
    </svg>
  );
}

/**
 * List icon for row view mode toggle.
 */
export function ListIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

/**
 * Hamburger icon for compact action menus.
 */
export function HamburgerIcon({ className = "", size = "h-5 w-5" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 7h16M4 12h16M4 17h16"
      />
    </svg>
  );
}

/**
 * Gear/settings icon for app settings.
 */
export function GearIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

/**
 * Refresh icon for reloading the page.
 */
export function RefreshIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h5"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 20v-5h-5"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 9a8 8 0 0113.292-4.293L20 9M20 15a8 8 0 01-13.292 4.293L4 15"
      />
    </svg>
  );
}

/**
 * Copy/path icon for copying file or directory paths.
 */
export function CopyPathIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 7h8M8 11h8M8 15h5"
      />
      <rect
        x="6"
        y="3"
        width="12"
        height="16"
        rx="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 21h7a2 2 0 002-2V7"
      />
    </svg>
  );
}

/**
 * Clipboard paste icon for inserting clipboard content.
 */
export function ClipboardPasteIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 5h6a2 2 0 012 2v12H7a2 2 0 01-2-2V7a2 2 0 012-2h2"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 3h6v4H9V3zM11 12h4M11 15h4"
      />
    </svg>
  );
}

/**
 * Text wrap icon for editor wrap controls.
 */
export function WrapTextIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 7h11a3 3 0 010 6H9"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 12h5m-2-3 3 3-3 3"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 17h7"
      />
    </svg>
  );
}

/**
 * Sidebar/panel icon for opening and closing the navigation rail.
 */
export function SidebarIcon({ className = "", size = "h-4 w-4" }: IconProps) {
  return (
    <svg
      className={`${size} ${className}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 4v16"
      />
    </svg>
  );
}
