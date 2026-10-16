import { AppShell } from "./components/AppShell";
import { ChatStateProvider } from "./hooks/chat-state-context";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

export function App() {
  return <ChatStateProvider><AppShell /></ChatStateProvider>;
}

export default App;
