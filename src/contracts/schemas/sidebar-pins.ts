import { z } from "zod";
import { sidebarPinSchema } from "@pablozaiden/webapp/contracts";

export const SidebarPinsSchema = z.array(sidebarPinSchema);
export const SidebarPinsResponseSchema = z.object({ pins: SidebarPinsSchema });
export const AddSidebarPinRequestSchema = z.object({ pin: sidebarPinSchema });
export const RemoveSidebarPinRequestSchema = z.object({ id: z.string().min(1) });
