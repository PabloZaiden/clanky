/**
 * Small user-intent contracts available before any catalog discovery.
 */
import { z } from "zod";
import { ModelConfigSchema, CheapModelSelectionSchema } from "@/contracts/schemas/model";
import { AgentSettingsSchema } from "@/contracts/schemas/workspace";
import { VoiceConfirmationDescriptionSchema } from "@/shared/live-voice";

const optionalText = z.string().trim().min(1).max(500).nullable().default(null);
const workspace = optionalText.describe("Workspace ID or exact name; null means no workspace filter.");
const target = z.string().trim().min(1).max(500).describe("ID, exact name, or 'current' for the originating client's selected entity. Never guess an ambiguous name.");
const model = ModelConfigSchema.nullable().default(null).describe("Explicit model override; null uses the actual saved/effective preference.");
const confirmation = VoiceConfirmationDescriptionSchema.nullable().default(null);
const message = z.string().trim().min(1).max(30_000);
const page = {
  cursor: z.string().min(1).max(4096).nullable().default(null),
  limit: z.number().int().min(1).max(20).nullable().default(null),
};
const exactStatus = optionalText.describe(
  "Exact underlying status filter. Leave null for Voice categories; use the returned voiceStatus field.",
);
const selection = { target, workspace };
const listing = { workspace, status: exactStatus, ...page };

export const liveVoiceDirectSchemas = {
  clanky_recent_work: z.object({
    kind: z.enum(["chat", "task", "all"]), ...listing,
  }).strict(),
  clanky_waiting_work: z.object({
    kind: z.enum(["chat", "task", "all"]), workspace, ...page,
  }).strict(),
  clanky_list_chats: z.object({ ...listing, name: optionalText }).strict(),
  clanky_read_chat: z.object({
    ...selection, range: z.enum(["latest", "earliest"]).default("latest"), ...page,
  }).strict(),
  clanky_send_chat_message: z.object({ ...selection, message }).strict(),
  clanky_steer_queued_chat_message: z.object({
    ...selection,
    messageId: optionalText.describe("Exact ID of an already queued message; null selects only when exactly one message is queued."),
  }).strict(),
  clanky_create_chat: z.object({
    name: optionalText, workspace, host: optionalText,
    directory: z.string().trim().min(1).max(16_384).nullable().default(null),
    model, useWorktree: z.boolean().nullable().default(null), baseBranch: optionalText,
    initialMessage: message.nullable().default(null), open: z.boolean().default(false),
    confirmationDescription: confirmation,
    afterCreationDescription: confirmation.describe("Required for initialMessage/open: short plain-text description in the user's language of these exact follow-on actions, shown together with creation for approval."),
  }).strict(),
  clanky_interrupt_chat: z.object({ ...selection }).strict(),
  clanky_update_chat_lifecycle: z.object({
    ...selection,
    action: z.enum(["mark_done", "move_to_trash"]),
    confirmationDescription: confirmation.describe(
      "Required for move_to_trash: one or two short sentences in the user's language naming the chat and explaining that active work will stop and the chat is recoverable in Trash for 30 days. Null only for mark_done.",
    ),
  }).strict(),
  clanky_respond_chat_interaction: z.object({
    ...selection, kind: z.enum(["question", "permission"]), requestId: optionalText,
    answers: z.array(z.array(z.string().min(1).max(10_000)).max(100)).min(1).max(100).nullable().default(null),
    decision: z.enum(["allow", "deny"]).nullable().default(null),
    confirmationDescription: confirmation,
  }).strict(),
  clanky_list_tasks: z.object({ ...listing, name: optionalText }).strict(),
  clanky_read_task: z.object({
    ...selection, range: z.enum(["latest", "earliest"]).default("latest"),
    section: z.enum(["conversation", "prompt", "plan", "diff"]).default("conversation"), ...page,
  }).strict(),
  clanky_create_task: z.object({
    name: z.string().trim().min(1).max(100), prompt: message, workspace, model,
    cheapModel: CheapModelSelectionSchema.nullable().default(null),
    draft: z.boolean(), baseBranch: optionalText, useWorktree: z.boolean().nullable().default(null),
    autoAcceptPlan: z.boolean().nullable().default(null), fullyAutonomous: z.boolean().nullable().default(null),
    confirmationDescription: confirmation,
  }).strict(),
  clanky_instruct_task: z.object({
    ...selection, intent: z.enum(["follow_up", "next_iteration"]), message,
  }).strict(),
  clanky_control_task: z.object({ ...selection, command: z.enum(["start_planning", "stop"]) }).strict(),
  clanky_review_task_plan: z.object({
    ...selection, action: z.enum(["feedback", "accept", "discard"]),
    feedback: message.nullable().default(null), confirmationDescription: confirmation,
  }).strict(),
  clanky_finish_task: z.object({
    ...selection, action: z.enum(["accept_local", "push"]), confirmationDescription: confirmation,
  }).strict(),
  clanky_list_workspaces: z.object({ ...page }).strict(),
  clanky_list_servers: z.object({
    kind: z.enum(["servers", "hosts", "all"]).default("all"), ...page,
  }).strict(),
  clanky_create_workspace: z.object({
    name: z.string().trim().min(1).max(100),
    host: target, directory: z.string().trim().min(1).max(16_384),
    agent: AgentSettingsSchema, workspaceType: z.enum(["git", "directory"]).default("git"),
    allowWorktrees: z.boolean().nullable().default(null),
    allowClankyContext: z.boolean().nullable().default(null),
    confirmationDescription: confirmation,
  }).strict(),
};

export type DirectToolName = keyof typeof liveVoiceDirectSchemas;
export type DirectToolInput<T extends DirectToolName> = z.infer<typeof liveVoiceDirectSchemas[T]>;

export const liveVoiceDirectDescriptions: Record<DirectToolName, string> = {
  clanky_recent_work: "Recent authorized chats/tasks ordered by real activity, with raw status, Voice status category and literal last-exchange previews. For chats, voiceStatus is active for streaming/waiting, idle for idle, done for done, and error for all other chat statuses. For tasks, active means planning/starting/running/waiting/resolving_conflicts; idle means idle/draft; done means completed/accepted_local/merged/pushed/deleted; error means stopped/failed/max_iterations. Direct: no discovery. kind=chat for chats. Cursor continues each selected source.",
  clanky_waiting_work: "Chats/tasks needing the user: pending questions, permissions AND ready plans awaiting manual approval. Includes actionable pending interactions, raw status and voiceStatus using the same chat/task categories as clanky_recent_work. Unavailable state is explicit. Direct, no discovery.",
  clanky_list_chats: "List compact chats by workspace, exact name and raw status, activity ordered. Each item retains status and includes voiceStatus: active for streaming/waiting, idle for idle, done for done, error for starting/interrupting/reconnecting/stopped/failed. Leave status null for Voice-category queries; do not filter active chats using a made-up raw status such as working. Direct, no discovery.",
  clanky_read_chat: "Read a named/ID/current chat's raw status, Voice status category, pending interactions and literal conversation together. latest selects the final messages directly; earliest starts history. Follow cursor for the selected range. Direct, no discovery.",
  clanky_send_chat_message: "Send one instruction to an existing named/ID/current chat. Resolves the target internally. Reports admission, not completed work. Never replay an uncertain mutation. Direct, no discovery.",
  clanky_steer_queued_chat_message: "Steer one existing queued chat message into a streaming native execution; this does not send new content. If messageId is null, proceeds only when exactly one message is queued. When several are queued, choose one of the returned candidates and pass its messageId. Reports native admission, not delivery or completion. Direct, no discovery.",
  clanky_create_chat: "Create a workspace or direct-host chat with real models/defaults. Choose workspace OR host. Optional frozen initialMessage/open are included in the visual confirmation and run only after creation is approved. Direct, no discovery.",
  clanky_interrupt_chat: "Interrupt an active named/ID/current chat. Stopping voice is different. Direct, no discovery.",
  clanky_update_chat_lifecycle: "Change a standalone chat's lifecycle only: mark_done uses the supported done action and does not interrupt busy work; move_to_trash stops work and keeps the chat recoverable for 30 days. move_to_trash requires a user-language confirmationDescription and the originating user's visual approval. Never set runtime statuses or permanently purge. Task chats remain task-managed; agent chats are not supported. Direct, no discovery.",
  clanky_respond_chat_interaction: "Answer a pending chat question (answers) or decide permission (decision). requestId=null selects only an unambiguous pending interaction. Permissions require visual confirmation. Direct, no discovery.",
  clanky_list_tasks: "List compact tasks by workspace, exact name and raw status, with progress, required-intervention reasons and Voice status category. Each item retains status and includes voiceStatus: active for planning/starting/running/waiting/resolving_conflicts, idle for idle/draft, done for completed/accepted_local/merged/pushed/deleted, error for stopped/failed/max_iterations. Leave status null for Voice-category queries. Direct, no discovery.",
  clanky_read_task: "Read task raw status, Voice status category and latest literal conversation, or an exact plan/diff section, together. No generated summary; do not claim complete history if omitted earlier messages or cursor remain. Direct, no discovery.",
  clanky_create_task: "Create a named task in a workspace, draft or planning. Resolves real models, branches, effective defaults and fresh browser preferences internally. Visual confirmation required. Direct, no discovery.",
  clanky_instruct_task: "Send a follow-up or queue a next-iteration instruction. Explicit intent; plan feedback belongs to review_task_plan. Admission is not delivery/completion. Direct, no discovery.",
  clanky_control_task: "Start planning for a draft task or stop active task execution. No invented resume behavior. Direct, no discovery.",
  clanky_review_task_plan: "Give feedback, accept a plan to start execution, or discard the plan AND delete its task. Accept/discard require visual confirmation. Direct, no discovery.",
  clanky_finish_task: "Accept completed task locally or push its branch. Push requires visual confirmation. Neither means an external PR merged. Direct, no discovery.",
  clanky_list_workspaces: "List owned workspace metadata and execution context without credentials. Direct, no discovery.",
  clanky_list_servers: "List owned SSH registrations and available local/SSH/Mesh hosts, known capabilities and availability without probing or secrets. Direct, no discovery.",
  clanky_create_workspace: "Create a workspace at an explicit directory on an exact host ID/name. Explicit adapter/provider and supported repository type. Uses the selected host, never server-local path guesses; visual confirmation required. Direct, no discovery.",
};
