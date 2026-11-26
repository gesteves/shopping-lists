"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { mutate } from "@/client/sync";
import { ITEM_NAME_MAX, NOTES_MAX } from "@/shared/ops";
import { PlusIcon } from "../../_components/icons";
import { Stepper } from "../../_components/stepper";

/**
 * The add bar at the bottom of a list. The name is required. The quantity
 * and the notes are behind "Details".
 */
export function AddBar({ listId }: { listId: string }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [details, setDetails] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), notes: useId(), details: useId() };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const args = {
      itemId: crypto.randomUUID(),
      listId,
      name: trimmed,
      quantity,
      notes: notes.trim(),
    };
    // Clear the form before the write: text typed for the next item while
    // the write runs must stay.
    setName("");
    setQuantity(1);
    setNotes("");
    setDetails(false);
    // Keep the keyboard open for the next item.
    input.current?.focus();
    await mutate({ type: "addItem", args });
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Add an item"
      className="sticky bottom-0 -mx-4 mt-auto border-t border-line bg-canvas/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:mx-0 lg:rounded-t-2xl lg:border-x"
    >
      {details && (
        <div id={ids.details} className="mb-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-ink-muted">Quantity</span>
            <Stepper value={quantity} onChange={setQuantity} label="Quantity" />
          </div>
          <label htmlFor={ids.notes} className="sr-only">
            Notes
          </label>
          <textarea
            id={ids.notes}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes, for example the brand or the size"
            maxLength={NOTES_MAX}
            rows={2}
            className="rounded-xl border border-ink-muted bg-surface px-4 py-2 placeholder:text-ink-muted"
          />
        </div>
      )}
      <div className="flex gap-2">
        <label htmlFor={ids.name} className="sr-only">
          Item name
        </label>
        <input
          ref={input}
          id={ids.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add an item"
          maxLength={ITEM_NAME_MAX}
          enterKeyHint="enter"
          autoComplete="off"
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-ink-muted bg-surface px-4 text-lg placeholder:text-ink-muted"
        />
        <button
          type="button"
          aria-expanded={details}
          aria-controls={ids.details}
          onClick={() => setDetails(!details)}
          className="min-h-12 rounded-xl px-3 font-medium text-accent hover:bg-accent-soft"
        >
          Details
        </button>
        <button
          type="submit"
          disabled={!name.trim()}
          className="flex min-h-12 items-center gap-1 rounded-xl bg-accent px-4 font-semibold text-accent-ink disabled:opacity-50"
        >
          <PlusIcon />
          Add
        </button>
      </div>
    </form>
  );
}
