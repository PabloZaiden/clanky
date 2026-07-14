import { AppShell } from "./components/AppShell";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

export function App() {
  return (
    <LogLevelInitializer>
      <AppShell />
    </LogLevelInitializer>
  );
}

export default App;
