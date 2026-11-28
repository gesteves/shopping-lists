// Toasts: short messages at the bottom of the screen, with an optional
// action such as Undo. A small external store, for useSyncExternalStore.
// The Toaster shows each toast in a <wa-toast-item>. The item closes itself
// after its duration (it shows a countdown ring, and it waits while the
// pointer is on it), then the Toaster removes it from the store.

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
  /** More actions, after `action`, on the same line (#131). */
  actions?: ToastAction[];
  /** A Font Awesome icon name. */
  icon?: string;
  variant?: "brand" | "success" | "warning" | "danger" | "neutral";
  /** In ms. 0 keeps the toast until the user closes it. */
  duration?: number;
}

/** How long a toast stays, in ms. Long enough to tap Undo. */
export const TOAST_MS = 5_000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * The server snapshot. React needs the same value at each call: a new
 * array at each call gives an endless loop warning.
 */
const SERVER_TOASTS: Toast[] = [];

export const toastStore = {
  getSnapshot: (): Toast[] => toasts,
  getServerSnapshot: (): Toast[] => SERVER_TOASTS,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Show a toast. Only the last three stay. */
export function showToast(toast: Omit<Toast, "id">): number {
  const id = nextId++;
  toasts = [...toasts, { duration: TOAST_MS, ...toast, id }].slice(-3);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
