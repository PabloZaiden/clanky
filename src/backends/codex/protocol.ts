/**
 * The supported slice of the official app-server contract.
 */

import type * as P from "./generated";

export interface CodexMethods {
  "initialize": [P.InitializeParams, P.InitializeResponse];
  "model/list": [P.ModelListParams, P.ModelListResponse];
  "thread/start": [P.ThreadStartParams, P.ThreadStartResponse];
  "thread/resume": [P.ThreadResumeParams, P.ThreadResumeResponse];
  "thread/read": [P.ThreadReadParams, P.ThreadReadResponse];
  "thread/list": [P.ThreadListParams, P.ThreadListResponse];
  "thread/delete": [P.ThreadDeleteParams, P.ThreadDeleteResponse];
  "thread/items/list": [P.ThreadItemsListParams, P.ThreadItemsListResponse];
  "thread/turns/list": [P.ThreadTurnsListParams, P.ThreadTurnsListResponse];
  "turn/start": [P.TurnStartParams, P.TurnStartResponse];
  "turn/steer": [P.TurnSteerParams, P.TurnSteerResponse];
  "turn/interrupt": [P.TurnInterruptParams, P.TurnInterruptResponse];
  "thread/backgroundTerminals/list": [P.ThreadBackgroundTerminalsListParams, P.ThreadBackgroundTerminalsListResponse];
  "thread/backgroundTerminals/terminate": [P.ThreadBackgroundTerminalsTerminateParams, P.ThreadBackgroundTerminalsTerminateResponse];
}

export type CodexNotification =
  | { method: "thread/started"; params: P.ThreadStartedNotification }
  | { method: "thread/status/changed"; params: P.ThreadStatusChangedNotification }
  | { method: "turn/started"; params: P.TurnStartedNotification }
  | { method: "turn/completed"; params: P.TurnCompletedNotification }
  | { method: "item/started"; params: P.ItemStartedNotification }
  | { method: "item/completed"; params: P.ItemCompletedNotification }
  | { method: "item/agentMessage/delta"; params: P.AgentMessageDeltaNotification }
  | { method: "item/reasoning/textDelta"; params: P.ReasoningTextDeltaNotification }
  | { method: "item/reasoning/summaryTextDelta"; params: P.ReasoningSummaryTextDeltaNotification }
  | { method: "item/commandExecution/outputDelta"; params: P.CommandExecutionOutputDeltaNotification }
  | { method: "error"; params: P.ErrorNotification }
  | { method: "serverRequest/resolved"; params: P.ServerRequestResolvedNotification };

export const CODEX_NOTIFICATION_METHODS = new Set<CodexNotification["method"]>([
  "thread/started", "thread/status/changed", "turn/started", "turn/completed",
  "item/started", "item/completed", "item/agentMessage/delta",
  "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta", "error", "serverRequest/resolved",
]);
