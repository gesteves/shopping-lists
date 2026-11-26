"use client";

import { QUANTITY_MAX } from "@/shared/ops";
import { MinusIcon, PlusIcon } from "./icons";

/** A quantity from 1 to QUANTITY_MAX, with − and + buttons. */
export function Stepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const button =
    "grid size-11 place-items-center rounded-lg text-accent hover:bg-accent-soft disabled:opacity-40";
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Fewer"
        disabled={value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
        className={button}
      >
        <MinusIcon />
      </button>
      <output
        aria-live="polite"
        className="min-w-8 text-center text-lg font-semibold tabular-nums"
      >
        {value}
      </output>
      <button
        type="button"
        aria-label="More"
        disabled={value >= QUANTITY_MAX}
        onClick={() => onChange(Math.min(QUANTITY_MAX, value + 1))}
        className={button}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
