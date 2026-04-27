// Thin re-export barrel — implementation lives in src/components/log-viewer/
import { LogViewer } from "./log-viewer";

export { ConversationViewer, LogViewer, getEntryGroupKey, annotateDisplayEntries } from "./log-viewer";
export { resetTranscriptFileLinkCache, looksLikeFileLinkCandidate } from "./log-viewer";
export type { ConversationViewerProps, LogEntry, LogViewerProps, DisplayEntry, EntryBase, TranscriptFileLinkContext, TranscriptFileLinkTarget } from "./log-viewer";
export default LogViewer;
