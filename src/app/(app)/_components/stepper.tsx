"use client";

import { clampQuantity } from "@/shared/quantity";
import { QUANTITY_MAX } from "@/shared/ops";

/**
 * A quantity from 1 to QUANTITY_MAX. The − and + buttons are "Fewer" and
 * "More" (web-awesome-setup.ts). When the user ends an edit (`change`), the
 * field shows the saved value: 0, an empty field, or more than the maximum
 * give the clamped value (#104).
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
  function onInput(event: Event) {
    const raw = (event.target as HTMLInputElement).value;
    // While the user types, keep a value that is not a number yet (an empty
    // field). The change event clamps it.
    const next = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(next)) {
      onChange(clampQuantity(raw, value));
    }
  }
  function onCommit(event: Event) {
    const field = event.target as HTMLInputElement;
    const next = clampQuantity(field.value, value);
    onChange(next);
    if (field.value !== String(next)) field.value = String(next);
  }
  return (
    <wa-number-input
      label={label}
      value={String(value)}
      min={1}
      max={QUANTITY_MAX}
      onInput={onInput}
      onChange={onCommit}
      inputmode="numeric"
      className="w-40"
    ></wa-number-input>
  );
}
