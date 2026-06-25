import type { ChildProcess } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

export type PortForwardSpawnFactory = (options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}) => ChildProcess;

export type LocalPortAllocator = (reservedPorts: Set<number>) => Promise<number>;

export interface RuntimeHandle {
  child: ChildProcess;
  deleting: boolean;
  user: CurrentUser;
}
