// Toasts: short messages at the bottom of the screen, with an optional
// action such as Undo. A small external store, for useSyncExternalStore.

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void | Promise<void> };
}

/** How long a toast stays, in ms. Long enough to tap Undo. */
export const TOAST_MS = 5_000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export const toastStore = {
  getSnapshot: (): Toast[] => toasts,
  getServerSnapshot: (): Toast[] => [],
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Show a toast. It goes after `ms`. Only the last three stay. */
export function showToast(toast: Omit<Toast, "id">, ms = TOAST_MS): number {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }].slice(-3);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
  emit();
  return id;
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
