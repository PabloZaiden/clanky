import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

interface ShellHeaderActionsContextValue {
  register: (owner: symbol, actions: ReactNode) => void;
  unregister: (owner: symbol) => void;
}

export const ShellHeaderActionsContext = createContext<ShellHeaderActionsContextValue | null>(null);

interface HeaderActionsStore {
  value: ReactNode;
  listeners: Set<() => void>;
  getSnapshot: () => ReactNode;
  subscribe: (listener: () => void) => () => void;
}

function createHeaderActionsStore(initialValue: ReactNode): HeaderActionsStore {
  const store: HeaderActionsStore = {
    value: initialValue,
    listeners: new Set(),
    getSnapshot: () => store.value,
    subscribe: (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  };
  return store;
}

function ShellHeaderActionsSlot({ store }: { store: HeaderActionsStore }) {
  const actions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{actions}</>;
}

export function useShellHeaderActions(actions: ReactNode): void {
  const context = useContext(ShellHeaderActionsContext);
  const ownerRef = useRef<symbol | null>(null);
  const storeRef = useRef<HeaderActionsStore | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = Symbol("shell-header-actions");
  }
  if (!storeRef.current) {
    storeRef.current = createHeaderActionsStore(actions);
  } else {
    storeRef.current.value = actions;
  }

  useEffect(() => {
    if (!context || !ownerRef.current || !storeRef.current) {
      return;
    }

    const owner = ownerRef.current;
    context.register(owner, <ShellHeaderActionsSlot store={storeRef.current} />);
    return () => context.unregister(owner);
  }, [context]);

  useEffect(() => {
    storeRef.current?.listeners.forEach((listener) => listener());
  }, [actions]);
}
