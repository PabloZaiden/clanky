/**
 * Voice-specific activity and short model intention labels.
 */

import { z } from "zod";

export interface LiveVoiceActivityEvent {
  type: "voice.activity";
  clientId: string;
  callId: string;
  processing: boolean;
  intention: string | null;
}

export const LiveVoiceIntentionSchema = z.string().trim().min(1).max(80)
  .refine((value) => !/[\r\n]/u.test(value), "Use one short line");
