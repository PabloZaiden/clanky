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
export { ComposerInterruptButton } from "./ComposerInterruptButton";
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
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
  getWorkerUpdateStepStatusBadgeVariant,
  getWorkerUpdateStepStatusLabel,
} from "./status-variants";
export {
  ActivityIcon,
  ChatIcon,
  ClipboardPasteIcon,
  CloseIcon,
  CodeIcon,
  CloudIcon,
  CopyPathIcon,
  EditIcon,
  FolderTreeIcon,
  GearIcon,
  GridIcon,
  ListIcon,
  MeshIcon,
  MicrophoneIcon,
  PreviewIcon,
  RefreshIcon,
  SaveIcon,
  ServerIcon,
  SidebarIcon,
  WrapTextIcon,
  type IconProps,
} from "./Icons";
export { ProviderIcon, getProviderIconKind, type ProviderIconKind } from "./ProviderIcon";
export { WorkspaceIconMark, WorkspaceIdentity } from "./WorkspaceIdentity";
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
