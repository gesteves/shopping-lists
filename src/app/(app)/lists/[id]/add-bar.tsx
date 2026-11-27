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
import { copy } from "@/copy";
import { mutate, type OpRequest } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { nameKey } from "@/shared/names";
import { ITEM_NAME_MAX, NOTES_MAX, QUANTITY_MAX } from "@/shared/ops";
import type { ItemRecord } from "@/shared/sync";
import { checkedFields, type Entry } from "@/client/duplicate";
import { Stepper } from "../../_components/stepper";
import { ConfirmDialog } from "../../_components/wa";

/**
 * The add bar at the bottom of a list. The name is required. The quantity
 * and the notes are behind the "Quantity and notes" button, below the name. Typing shows suggestions from past
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
  const ids = {
    name: useId(),
    notes: useId(),
    details: useId(),
    listbox: useId(),
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
    if (match) {
      // Keep the form: Cancel must not lose the name, quantity, and notes.
      // It clears when the user confirms (#104).
      setDismissed(true);
      setDuplicate({ item: match, entry });
      return;
    }
    reset();
    // Keep the keyboard open for the next item.
    input.current?.focus();
    await write(entry, [
      {
        type: "addItem",
        args: {
          itemId: crypto.randomUUID(),
          listId,
          name: entry.name.trim(),
          quantity: entry.quantity,
          notes: entry.notes.trim(),
        },
      },
    ]);
  }

  /**
   * Do the writes of an entry. The form is clear already, thus a failed
   * write shows a toast with the name. The other ops of the entry stop.
   */
  async function write(entry: Entry, requests: OpRequest[]) {
    try {
      for (const request of requests) await mutate(request);
    } catch (error) {
      console.error(error);
      // Plain, like the toasts of the changes that the server refused.
      showToast({ message: copy.addBar.failed(entry.name.trim()) });
    }
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
    setDuplicate(null);
    reset();
    if (item.checked) {
      const fields = checkedFields(item, entry);
      await write(entry, [
        { type: "uncheck", args: { itemId: item.id } },
        ...(fields
          ? [{ type: "updateItem" as const, args: { itemId: item.id, fields } }]
          : []),
      ]);
    } else {
      await write(entry, [
        {
          type: "updateItem",
          args: {
            itemId: item.id,
            fields: {
              quantity: Math.min(QUANTITY_MAX, item.quantity + entry.quantity),
            },
          },
        },
      ]);
    }
    input.current?.focus();
  }

  return (
    <form
      onSubmit={submit}
      aria-label={copy.addBar.label}
      // -mb-(--main-pb): no gap below the bar (layout.tsx).
      className="sticky bottom-0 -mx-4 mt-auto -mb-(--main-pb) border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:mx-0 lg:rounded-t-2xl lg:border-x"
    >
      {open && (
        <ul
          id={ids.listbox}
          role="listbox"
          aria-label={copy.addBar.suggestions}
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
              className={`flex min-h-12 cursor-pointer items-center px-4 py-2 text-lg leading-snug wrap-anywhere ${i === active ? "bg-accent-soft" : "hover:bg-accent-soft"}`}
            >
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <label htmlFor={ids.name} className="sr-only">
          {copy.addBar.name}
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
          placeholder={copy.addBar.placeholder}
          maxLength={ITEM_NAME_MAX}
          enterKeyHint="enter"
          autoComplete="off"
          // A native input (the suggestions need aria-activedescendant),
          // with the look of a large <wa-input>.
          className="h-(--wa-form-control-height) min-w-0 flex-1 rounded-(--wa-form-control-border-radius) border-(length:--wa-form-control-border-width) border-(--wa-form-control-border-color) bg-(--wa-form-control-background-color) px-(--wa-form-control-padding-inline) text-(length:--wa-font-size-l) text-(--wa-form-control-value-color) placeholder:text-(--wa-form-control-placeholder-color)"
        />
        <wa-button
          appearance="plain"
          size="l"
          aria-expanded={details}
          aria-controls={ids.details}
          onClick={() => setDetails(!details)}
        >
          <wa-icon name="sliders" label={copy.addBar.details}></wa-icon>
        </wa-button>
        <wa-button
          type="submit"
          variant="brand"
          size="l"
          disabled={!name.trim()}
        >
          <wa-icon slot="start" name="plus"></wa-icon>
          {copy.addBar.add}
        </wa-button>
      </div>
      {details && (
        <div id={ids.details} className="mt-3 flex flex-col gap-3">
          <Stepper
            value={quantity}
            onChange={setQuantity}
            label={copy.addBar.quantity}
          />
          <wa-textarea
            label={copy.addBar.notes}
            value={notes}
            onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
            placeholder={copy.addBar.notesPlaceholder}
            maxlength={NOTES_MAX}
            rows={2}
          ></wa-textarea>
        </div>
      )}
      <ConfirmDialog
        open={duplicate !== null}
        label={
          duplicate?.item.checked
            ? copy.addBar.checkedTitle(duplicate.item.name)
            : copy.addBar.duplicateTitle(duplicate?.item.name ?? "")
        }
        confirmLabel={
          duplicate?.item.checked
            ? copy.addBar.checkedConfirm
            : copy.addBar.duplicateConfirm
        }
        onConfirm={resolveDuplicate}
        onClose={() => setDuplicate(null)}
      >
        {duplicate &&
          (duplicate.item.checked
            ? checkedBody(duplicate.item, duplicate.entry)
            : copy.addBar.duplicateBody(
                duplicate.entry.quantity,
                Math.min(
                  QUANTITY_MAX,
                  duplicate.item.quantity + duplicate.entry.quantity,
                ),
              ))}
      </ConfirmDialog>
    </form>
  );
}

/** The text of the prompt for a checked item. It tells the changes. */
function checkedBody(item: ItemRecord, entry: Entry) {
  const fields = checkedFields(item, entry);
  return fields
    ? copy.addBar.checkedBodyChanges(
        fields.quantity,
        fields.notes !== undefined,
      )
    : copy.addBar.checkedBody;
}
