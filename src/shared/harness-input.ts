/**
 * Browser/server-safe input parts accepted by harness adapters.
 */

export type PromptPart = TextPromptPart | ImagePromptPart | ResourcePromptPart;

export interface TextPromptPart {
  type: "text";
  text: string;
}

export interface ImagePromptPart {
  type: "image";
  mimeType: string;
  /** Base64-encoded image data. */
  data: string;
  filename?: string;
}

export type ResourcePromptPart = TextResourcePromptPart | BlobResourcePromptPart;

export interface TextResourcePromptPart {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text: string;
  };
}

export interface BlobResourcePromptPart {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    /** Base64-encoded binary content. */
    blob: string;
  };
}

export interface PromptInput {
  parts: PromptPart[];
  model?: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
}
