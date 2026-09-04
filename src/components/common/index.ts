/**
 * Central export for all common components.
 */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export {
  FocusPreservingButton,
  preventButtonFocusOnMouseDown,
  preventButtonFocusOnPointerDown,
  type FocusPreservingButtonProps,
} from "./FocusPreservingButton";
export { Card, type CardProps } from "./Card";
export {
  Badge,
  StatusBadge,
  formatStatusLabel,
  type BadgeProps,
  type BadgeVariant,
} from "@pablozaiden/webapp/web";
export {
  getAgentStatusBadgeVariant,
  getChatStatusBadgeVariant,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
  getProvisioningStatusBadgeVariant,
  getProvisioningStatusLabel,
} from "./status-variants";
export {
  ActivityIcon,
  ChatIcon,
  ClipboardPasteIcon,
  CodeIcon,
  CloudIcon,
  CopyPathIcon,
  EditIcon,
  FolderTreeIcon,
  GearIcon,
  GridIcon,
  ListIcon,
  MeshIcon,
  RefreshIcon,
  ServerIcon,
  SidebarIcon,
  WrapTextIcon,
  type IconProps,
} from "./Icons";
export { CollapsibleSection, type CollapsibleSectionProps } from "./CollapsibleSection";
export { PASSWORD_INPUT_PROPS } from "./passwordInputProps";
export {
  getComposerMinHeightClass,
  getComposerPaddingClass,
  getComposerRows,
  useComposerSizing,
  type ComposerRowsMeasurement,
  type ComposerMinHeightClass,
  type ComposerPaddingClass,
  type ComposerRows,
} from "./composer-rows";
export {
  isVisualViewportReduced,
  useVisualViewport,
  type VisualViewportState,
} from "./use-visual-viewport";
