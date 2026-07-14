import { AppShell } from "./components/AppShell";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import { StandaloneChatTranscriptViewer } from "./components/StandaloneChatTranscriptViewer";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

const CHAT_TRANSCRIPT_HASH_PREFIX = "/chat-transcript/";

function getTranscriptChatIdFromHash(hash: string): string | null {
  if (!hash.startsWith(`#${CHAT_TRANSCRIPT_HASH_PREFIX}`)) {
    return null;
  }

  try {
    return decodeURIComponent(hash.slice(CHAT_TRANSCRIPT_HASH_PREFIX.length + 1));
  } catch (error) {
    console.warn("Ignoring malformed chat transcript route", error);
    return null;
  }
}

export function App() {
  const transcriptChatId = getTranscriptChatIdFromHash(window.location.hash);

  return (
    <LogLevelInitializer>
      {transcriptChatId ? <StandaloneChatTranscriptViewer chatId={transcriptChatId} /> : <AppShell />}
    </LogLevelInitializer>
  );
}

export default App;
