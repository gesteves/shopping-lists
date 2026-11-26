"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useSuggestionCandidates } from "@/client/hooks";
import { rankSuggestions } from "@/client/suggest";
import { mutate } from "@/client/sync";
import { nameKey } from "@/shared/names";
import { ITEM_NAME_MAX, NOTES_MAX, QUANTITY_MAX } from "@/shared/ops";
import type { ItemRecord } from "@/shared/sync";
import { PlusIcon } from "../../_components/icons";
import { Stepper } from "../../_components/stepper";

interface Entry {
  name: string;
  quantity: number;
  notes: string;
}

/**
 * The add bar at the bottom of a list. The name is required. The quantity
 * and the notes are behind "Details". Typing shows suggestions from past
 * items (#14). A name that is already on the list asks first.
 */
export function AddBar({
  listId,
  items,
}: {
  listId: string;
  /** The items of this list that are not deleted. */
  items: ItemRecord[];
}) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [details, setDetails] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const [duplicate, setDuplicate] = useState<{
    item: ItemRecord;
    entry: Entry;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = {
    name: useId(),
    notes: useId(),
    details: useId(),
    listbox: useId(),
    dialogTitle: useId(),
  };

  const candidates = useSuggestionCandidates();
  const suggestions = useMemo(() => {
    if (!candidates) return [];
    // The unchecked items of this list are there already.
    const exclude = new Set(
      items.filter((i) => !i.checked).map((i) => nameKey(i.name)),
    );
    return rankSuggestions(name, candidates, { exclude });
  }, [candidates, items, name]);
  const open = focused && !dismissed && suggestions.length > 0;

  function reset() {
    // Clear the form before the write: text typed for the next item while
    // the write runs must stay.
    setName("");
    setQuantity(1);
    setNotes("");
    setDetails(false);
    setActive(-1);
    setDismissed(false);
  }

  async function add(entry: Entry) {
    const key = nameKey(entry.name);
    if (!key) return;
    const match = items.find((i) => nameKey(i.name) === key);
    reset();
    if (match) {
      setDuplicate({ item: match, entry });
      dialog.current?.showModal();
      return;
    }
    // Keep the keyboard open for the next item.
    input.current?.focus();
    await mutate({
      type: "addItem",
      args: {
        itemId: crypto.randomUUID(),
        listId,
        name: entry.name.trim(),
        quantity: entry.quantity,
        notes: entry.notes.trim(),
      },
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void add({ name, quantity, notes });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      void add({ name: suggestions[active].name, quantity, notes });
    }
  }

  async function resolveDuplicate() {
    if (!duplicate) return;
    const { item, entry } = duplicate;
    dialog.current?.close();
    if (item.checked) {
      await mutate({ type: "uncheck", args: { itemId: item.id } });
    } else {
      await mutate({
        type: "updateItem",
        args: {
          itemId: item.id,
          fields: {
            quantity: Math.min(QUANTITY_MAX, item.quantity + entry.quantity),
          },
        },
      });
    }
    input.current?.focus();
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Add an item"
      className="sticky bottom-0 -mx-4 mt-auto border-t border-line bg-canvas/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:mx-0 lg:rounded-t-2xl lg:border-x"
    >
      {open && (
        <ul
          id={ids.listbox}
          role="listbox"
          aria-label="Suggestions"
          className="absolute inset-x-4 bottom-full mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              id={`${ids.listbox}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep the focus in the field, so the keyboard stays open.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void add({ name: s.name, quantity, notes })}
              className={`flex min-h-12 cursor-pointer items-center px-4 text-lg ${i === active ? "bg-accent-soft" : "hover:bg-accent-soft"}`}
            >
              {s.name}
            </li>
          ))}
        </ul>
      )}
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
          onChange={(e) => {
            setName(e.target.value);
            setActive(-1);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={ids.listbox}
          aria-activedescendant={
            open && active >= 0 ? `${ids.listbox}-${active}` : undefined
          }
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
      <dialog
        ref={dialog}
        aria-labelledby={ids.dialogTitle}
        onClose={() => setDuplicate(null)}
        className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/40"
      >
        {duplicate && (
          <>
            <h2
              id={ids.dialogTitle}
              className="text-xl font-semibold text-balance"
            >
              {duplicate.item.checked
                ? `Already on the list. Uncheck “${duplicate.item.name}”?`
                : `“${duplicate.item.name}” is already on the list.`}
            </h2>
            <p className="mt-2 text-ink-muted">
              {duplicate.item.checked
                ? "It’s checked off. Uncheck it to get it again."
                : `Add ${duplicate.entry.quantity} more? Then it’s ×${Math.min(QUANTITY_MAX, duplicate.item.quantity + duplicate.entry.quantity)}.`}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                className="min-h-11 rounded-lg px-4 font-medium text-accent hover:bg-accent-soft"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={resolveDuplicate}
                className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-accent-ink"
              >
                {duplicate.item.checked ? "Uncheck" : "Add more"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </form>
  );
}
