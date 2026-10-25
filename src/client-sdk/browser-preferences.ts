/**
 * Validated device preferences for a browser collaboration profile.
 */

import { clientScopedStorageKey } from "@pablozaiden/webapp/web";
import type { z } from "zod";
import { DomainError } from "../domain/domain-error";
import {
  PromptTemplateListSchema,
  QuickChatSettingsSchema,
  SetDashboardViewModeRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetMarkdownRenderingRequestSchema,
} from "../contracts/schemas/preferences";
import { CheapModelSelectionSchema, ModelConfigSchema } from "../contracts/schemas/model";
import { CollaborationNameSchema } from "../contracts/schemas/collaboration";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "../shared/preferences";

export interface BrowserPreference<T> {
  read: (signal?: AbortSignal) => T;
  write: (value: T, signal?: AbortSignal) => T;
  subscribe: (listener: () => void) => () => void;
}

function createPreference<T>(key: string, schema: z.ZodType<T>, initial: T): BrowserPreference<T> {
  const listeners = new Set<() => void>();
  const storageKey = () => clientScopedStorageKey(`clanky.preference.${key}`);
  const validate = (value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new DomainError("client_preference_invalid", `The saved ${key} preference is invalid.`, { cause: parsed.error });
    }
    return parsed.data;
  };
  return {
    read(signal) {
      signal?.throwIfAborted();
      let stored: string | null;
      try {
        stored = localStorage.getItem(storageKey());
      } catch (error) {
        throw new DomainError("client_preference_unavailable", `Could not read the ${key} device preference.`, { cause: error });
      }
      if (stored === null) return validate(initial);
      let value: unknown;
      try {
        value = JSON.parse(stored);
      } catch (error) {
        throw new DomainError("client_preference_invalid", `The saved ${key} preference is unreadable.`, { cause: error });
      }
      return validate(value);
    },
    write(value, signal) {
      signal?.throwIfAborted();
      const parsed = validate(value);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(parsed));
      } catch (error) {
        throw new DomainError("client_preference_unavailable", `Could not save the ${key} device preference.`, { cause: error });
      }
      for (const listener of listeners) listener();
      return parsed;
    },
    subscribe(listener) {
      const handleStorage = (event: StorageEvent) => {
        if (event.storageArea === localStorage && (event.key === null || event.key === storageKey())) listener();
      };
      listeners.add(listener);
      window.addEventListener("storage", handleStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", handleStorage);
      };
    },
  };
}

export const browserPreferences = {
  quickChat: createPreference("quick-chat", QuickChatSettingsSchema, DEFAULT_QUICK_CHAT_SETTINGS),
  markdown: createPreference("markdown-rendering", SetMarkdownRenderingRequestSchema.shape.enabled, true),
  fullTree: createPreference("file-explorer-full-tree", SetFileExplorerFullTreeRequestSchema.shape.enabled, true),
  viewMode: createPreference("dashboard-view-mode", SetDashboardViewModeRequestSchema.shape.mode, "rows"),
  promptTemplates: createPreference("prompt-templates", PromptTemplateListSchema, []),
  lastModel: createPreference("last-model", ModelConfigSchema.nullable(), null),
  lastCheapModel: createPreference("last-cheap-model", CheapModelSelectionSchema.nullable(), null),
  collaborationName: createPreference("collaboration-name", CollaborationNameSchema.nullable(), null),
};
