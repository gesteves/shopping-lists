"use client";

// Helpers for Web Awesome components in React (#51).
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { copy } from "@/copy";

type Listeners = Record<string, (event: Event) => void>;

/**
 * A callback ref that adds `wa-*` event listeners. React hydration does not
 * attach `onwa-*` props on server-rendered tags, thus use this. The event
 * names must not change between renders; the handlers can.
 */
export function useWaEvents<T extends HTMLElement>(listeners: Listeners) {
  const latest = useRef(listeners);
  useEffect(() => {
    latest.current = listeners;
  });
  return useCallback((el: T | null) => {
    if (!el) return;
    const added = Object.keys(latest.current).map((type) => {
      const fn = (event: Event) => latest.current[type]?.(event);
      el.addEventListener(type, fn);
      return [type, fn] as const;
    });
    return () => {
      for (const [type, fn] of added) el.removeEventListener(type, fn);
    };
  }, []);
}

/**
 * A dialog that asks before an action. `open` is the React state; Escape,
 * the close button, and Cancel call `onClose`.
 */
export function ConfirmDialog({
  open,
  label,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  label: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useWaEvents<HTMLElement>({
    // Only this dialog: events of fields in it bubble too.
    "wa-after-hide": (event) => {
      if (event.target === event.currentTarget) onClose();
    },
  });
  return (
    <wa-dialog ref={ref} open={open} label={label} light-dismiss>
      <div className="text-ink-muted">{children}</div>
      <wa-button slot="footer" appearance="plain" onClick={onClose}>
        {copy.common.cancel}
      </wa-button>
      <wa-button
        slot="footer"
        variant={danger ? "danger" : "brand"}
        onClick={onConfirm}
      >
        {confirmLabel}
      </wa-button>
    </wa-dialog>
  );
}
