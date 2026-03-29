export class MissingChatHistoryError extends Error {
  readonly code = "MISSING_CHAT_HISTORY";

  constructor(message = "Cannot convert chat to loop because there is no chat history to build a plan from.") {
    super(message);
    this.name = "MissingChatHistoryError";
  }
}
