"use client";

import { QUANTITY_MAX } from "@/shared/ops";

/**
 * A quantity from 1 to QUANTITY_MAX. The − and + buttons are "Fewer" and
 * "More" (web-awesome-setup.ts).
 */
export function Stepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  function read(event: Event) {
    const next = Number((event.target as HTMLInputElement).value);
    if (Number.isInteger(next) && next >= 1) {
      onChange(Math.min(QUANTITY_MAX, next));
    }
  }
  return (
    <wa-number-input
      label={label}
      value={String(value)}
      min={1}
      max={QUANTITY_MAX}
      onInput={read}
      onChange={read}
      inputmode="numeric"
      className="w-40"
    ></wa-number-input>
  );
}
