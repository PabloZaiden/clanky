/**
 * Canonical application-control intents shared by all client adapters.
 */
import { z } from "zod";
import { ModelConfigSchema, CheapModelSelectionSchema } from "@/contracts/schemas/model";
import { AgentSettingsSchema } from "@/contracts/schemas/workspace";
import { ControlConfirmationDescriptionSchema } from "@/shared/control-interactions";
import { ExecuteOperationSchema, type ControlToolDefinition } from "@/contracts/schemas/control";
import { AgentNotificationSchema } from "@/contracts/schemas/agent-notifications";
import { AGENT_NOTIFICATION_INSTRUCTIONS } from "@/shared/agent-notifications";

const optionalText = z.string().trim().min(1).max(500).nullable().default(null);
const workspace = optionalText.describe("Workspace ID or exact name; null means no workspace filter.");
const target = z.string().trim().min(1).max(500).describe("ID, exact name, or 'current' for the originating client's selected entity. Never guess an ambiguous name.");
const model = ModelConfigSchema.nullable().default(null).describe("Explicit model override; null uses the actual saved/effective preference.");
const confirmation = ControlConfirmationDescriptionSchema.nullable().default(null);
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

export const controlDirectSchemas = {
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
      "For move_to_trash, describe the named chat, stopped active work and 30-day recoverable Trash behavior. Required when confirmation is enabled (always in Voice); null is allowed when it is disabled or for mark_done.",
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

export type DirectToolName = keyof typeof controlDirectSchemas;
export type DirectToolInput<T extends DirectToolName> = z.infer<typeof controlDirectSchemas[T]>;

export const controlDirectDescriptions: Record<DirectToolName, string> = {
  clanky_recent_work: "Recent authorized chats/tasks ordered by real activity, with raw status, Voice status category and literal last-exchange previews. For chats, voiceStatus is active for streaming/waiting, idle for idle, done for done, and error for all other chat statuses. For tasks, active means planning/starting/running/waiting/resolving_conflicts; idle means idle/draft; done means completed/accepted_local/merged/pushed/deleted; error means stopped/failed/max_iterations. Direct: no discovery. kind=chat for chats. Cursor continues each selected source.",
  clanky_waiting_work: "Chats/tasks needing the user: pending questions, permissions AND ready plans awaiting manual approval. Includes actionable pending interactions, raw status and voiceStatus using the same chat/task categories as clanky_recent_work. Unavailable state is explicit. Direct, no discovery.",
  clanky_list_chats: "List compact chats by workspace, exact name and raw status, activity ordered. Each item retains status and includes voiceStatus: active for streaming/waiting, idle for idle, done for done, error for starting/interrupting/reconnecting/stopped/failed. Leave status null for Voice-category queries; do not filter active chats using a made-up raw status such as working. Direct, no discovery.",
  clanky_read_chat: "Read a named/ID/current chat's raw status, Voice status category, pending interactions and literal conversation together. latest selects the final messages directly; earliest starts history. Follow cursor for the selected range. Direct, no discovery.",
  clanky_send_chat_message: "Send one instruction to an existing named/ID/current chat. Resolves the target internally. Reports admission, not completed work. Never replay an uncertain mutation. Direct, no discovery.",
  clanky_steer_queued_chat_message: "Steer one existing queued chat message into a streaming native execution; this does not send new content. If messageId is null, proceeds only when exactly one message is queued. When several are queued, choose one of the returned candidates and pass its messageId. Reports native admission, not delivery or completion. Direct, no discovery.",
  clanky_create_chat: "Create a workspace or direct-host chat with real models/defaults. Choose workspace OR host. Optional initialMessage/open run after successful creation and are included in its confirmation when required by the user's nonvoice setting; Voice always confirms. Direct, no discovery.",
  clanky_interrupt_chat: "Interrupt an active named/ID/current chat. Stopping voice is different. Direct, no discovery.",
  clanky_update_chat_lifecycle: "Change a standalone chat's lifecycle only: mark_done uses the supported done action and does not interrupt busy work; move_to_trash stops work and keeps the chat recoverable for 30 days. Trash confirmation follows the user's nonvoice approval setting; Voice always requires a user-language confirmationDescription and visual approval. Never set runtime statuses or permanently purge. Task chats remain task-managed; agent chats are not supported. Direct, no discovery.",
  clanky_respond_chat_interaction: "Answer a pending chat question (answers) or decide permission (decision). requestId=null selects only an unambiguous pending interaction. Permission decisions follow the user's nonvoice approval setting; Voice always confirms. Direct, no discovery.",
  clanky_list_tasks: "List compact tasks by workspace, exact name and raw status, with progress, required-intervention reasons and Voice status category. Each item retains status and includes voiceStatus: active for planning/starting/running/waiting/resolving_conflicts, idle for idle/draft, done for completed/accepted_local/merged/pushed/deleted, error for stopped/failed/max_iterations. Leave status null for Voice-category queries. Direct, no discovery.",
  clanky_read_task: "Read task raw status, Voice status category and latest literal conversation, or an exact plan/diff section, together. No generated summary; do not claim complete history if omitted earlier messages or cursor remain. Direct, no discovery.",
  clanky_create_task: "Create a named task in a workspace, draft or planning. Resolves real models, branches, effective defaults and fresh browser preferences internally. Confirmation follows the user's nonvoice approval setting; Voice always confirms. Direct, no discovery.",
  clanky_instruct_task: "Send a follow-up or queue a next-iteration instruction. Explicit intent; plan feedback belongs to review_task_plan. Admission is not delivery/completion. Direct, no discovery.",
  clanky_control_task: "Start planning for a draft task or stop active task execution. No invented resume behavior. Direct, no discovery.",
  clanky_review_task_plan: "Give feedback, accept a plan to start execution, or discard the plan AND delete its task. Accept/discard confirmation follows the user's nonvoice approval setting; Voice always confirms. Direct, no discovery.",
  clanky_finish_task: "Accept completed task locally or push its branch. Push confirmation follows the user's nonvoice approval setting; Voice always confirms. Neither means an external PR merged. Direct, no discovery.",
  clanky_list_workspaces: "List owned workspace metadata and execution context without credentials. Direct, no discovery.",
  clanky_list_servers: "List owned SSH registrations and available local/SSH/Mesh hosts, known capabilities and availability without probing or secrets. Direct, no discovery.",
  clanky_create_workspace: "Create a workspace at an explicit directory on an exact host ID/name. Explicit adapter/provider and supported repository type. Uses the selected host, never server-local path guesses. Confirmation follows the user's nonvoice approval setting; Voice always confirms. Direct, no discovery.",
};

export const controlToolSchemas = {
  ...controlDirectSchemas,
  clanky_send_notification: AgentNotificationSchema,
  clanky_list_operations: z.object({}).strict(),
  clanky_find_operations: z.object({
    text: z.string().max(500),
    domain: z.string().max(100).nullable(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).nullable(),
    cursor: z.number().int().nonnegative().max(10_000).nullable(),
  }).strict(),
  clanky_describe_operation: z.object({
    operationId: z.string().min(1).max(500),
    section: z.enum(["overview", "query", "body"]).nullable().default(null),
    cursor: z.string().max(4096).nullable().default(null),
  }).strict(),
  clanky_execute_operation: ExecuteOperationSchema.extend({
    confirmationDescription: ControlConfirmationDescriptionSchema.nullable(),
  }),
};

export type ControlToolName = keyof typeof controlToolSchemas;
export type ControlToolInput<T extends ControlToolName> = z.input<typeof controlToolSchemas[T]>;

export const controlToolDescriptions: Record<ControlToolName, string> = {
  ...controlDirectDescriptions,
  clanky_send_notification: "Send one text notification to the user's configured Listen webhook. "
    + AGENT_NOTIFICATION_INSTRUCTIONS
    + " Supply title, shortDescription and markdownContent; never supply a webhook URL. "
    + "Returns webhook acceptance, not human receipt. Direct, no discovery or extra approval.",
  clanky_list_operations: "Get the complete authorized operation index in one call, without schemas or pagination. columns names the fields in each operations row: operationId, policy, description. Descriptions are abbreviated; describe the selected operation for its exact inputs and consequences. Prefer this index over repeated keyword searches for uncovered intents. Direct tools need no discovery. In Live Voice call this tool alone.",
  clanky_find_operations: "Filtered lookup for intents not covered by a direct tool. Matches all words literally, with optional domain/method filters. Empty text lists a page; follow nextCursor. Use clanky_list_operations for the complete compact index in one call instead of repeated keyword guesses.",
  clanky_describe_operation: "Read the exact contract and risk/completion policy. Start with section/cursor null; if contractSections are returned, read query/body separately. Content parts identify JSON paths; continue with nextCursor until null to obtain the complete schema.",
  clanky_execute_operation: "Execute a described API operation with exact parameters/query and bodyJson (null without a body). Reads automatically select compact pages or literal conversation history. Follow nextCursor with the same read operation, filters and public body to read more; section=details and item read a row's original content. Content parts contain JSON paths and string offsets, not a generated summary. For policy confirm, supply confirmationDescription: one or two short plain-text sentences in the user's language describing the exact action, named target and material consequences. No API paths, technical identifiers, JSON or credentials. Use null for other policies. Confirm-class actions wait for a visual decision unless the user's nonvoice approval setting is off; Voice always confirms. Inspect the returned pending/completion status. Mutations are never retried automatically.",
};

export const controlToolDefinitions: ControlToolDefinition[] = Object.entries(controlToolSchemas).map(([name, schema]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return { name, description: controlToolDescriptions[name as ControlToolName], inputSchema };
});

export function isControlToolName(name: string): name is ControlToolName {
  return Object.hasOwn(controlToolSchemas, name);
}
