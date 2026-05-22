/**
 * Core manager for task-scoped SSH port forwards.
 * @see src/core/port-forward/ for implementation sub-modules.
 */

export { PortForwardManager, portForwardManager } from "./port-forward";
export type { LocalPortAllocator, PortForwardSpawnFactory, RuntimeHandle } from "./port-forward";
