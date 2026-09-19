import type {
  MessageAttachment,
  ModelConfig,
} from "@/shared";
import type { VoiceRecorderStatus } from "../../hooks/useVoiceRecorder";

export interface ConversationComposerSubmission {
  message: string | null;
  model: ModelConfig | null;
  attachments: MessageAttachment[];
}

export interface ConversationComposerNotice {
  message: string;
  actionLabel: string;
  onAction: () => Promise<void>;
}

export interface ConversationComposerStatus {
  label: string;
}

export interface ConversationComposerVoice {
  available: boolean;
  status: VoiceRecorderStatus;
  elapsedMs: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  dismissError: () => void;
  registerDraft: (
    setDraft: (text: string) => void,
    getDraft: () => string,
    submitDraft: (text: string) => Promise<void>,
  ) => () => void;
}

export interface ConversationComposerProps {
  draftId: string;
  currentModel: ModelConfig;
  modelWorkspaceId?: string;
  modelEnabled?: boolean;
  attachmentsEnabled?: boolean;
  active: boolean;
  externallyBusy?: boolean;
  disabled?: boolean;
  requireMessage?: boolean;
  requireMessageForAttachments?: boolean;
  notice?: ConversationComposerNotice;
  status?: ConversationComposerStatus;
  voice?: ConversationComposerVoice;
  onSubmit: (submission: ConversationComposerSubmission) => Promise<boolean | void>;
  onInterrupt?: () => Promise<boolean | void>;
}
