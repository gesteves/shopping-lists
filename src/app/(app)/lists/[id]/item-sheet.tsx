"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useUsers } from "@/client/hooks";
import { itemHistory } from "@/client/format";
import { mutate } from "@/client/sync";
import { ITEM_NAME_MAX, NOTES_MAX } from "@/shared/ops";
import type { ItemRecord } from "@/shared/sync";
import { Stepper } from "../../_components/stepper";

/**
 * Edit an item: name, quantity, and notes, with who added and changed it.
 * A bottom sheet on a phone, a centered dialog on a large screen.
 */
export function ItemSheet({
  item,
  onClose,
}: {
  item: ItemRecord | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (item && el && !el.open) {
      el.showModal();
      // showModal() focuses the name field, and a phone then opens the
      // keyboard. Focus the dialog instead: most edits are the quantity.
      el.focus();
    }
    if (!item && el?.open) el.close();
  }, [item]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      tabIndex={-1}
      aria-labelledby="item-sheet-title"
      className="fixed inset-x-0 top-auto bottom-0 m-0 outline-none max-h-[90dvh] w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40 lg:inset-0 lg:m-auto lg:max-w-lg lg:rounded-2xl"
    >
      {item && <SheetForm key={item.id} item={item} dialog={dialog} />}
    </dialog>
  );
}

function SheetForm({
  item,
  dialog,
}: {
  item: ItemRecord;
  dialog: React.RefObject<HTMLDialogElement | null>;
}) {
  const users = useUsers();
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [notes, setNotes] = useState(item.notes);
  const ids = { name: useId(), notes: useId() };
  const close = () => dialog.current?.close();

  async function save(event: FormEvent) {
    event.preventDefault();
    const fields: { name?: string; quantity?: number; notes?: string } = {};
    if (name.trim() && name.trim() !== item.name) fields.name = name.trim();
    if (quantity !== item.quantity) fields.quantity = quantity;
    if (notes.trim() !== item.notes) fields.notes = notes.trim();
    if (Object.keys(fields).length > 0) {
      await mutate({ type: "updateItem", args: { itemId: item.id, fields } });
    }
    close();
  }

  async function remove() {
    await mutate({ type: "deleteItem", args: { itemId: item.id } });
    close();
  }

  return (
    <form
      onSubmit={save}
      className="flex flex-col gap-5 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
    >
      <h2 id="item-sheet-title" className="text-xl font-semibold">
        Edit item
      </h2>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={ids.name}
          className="text-sm font-medium text-ink-muted"
        >
          Name
        </label>
        <input
          id={ids.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={ITEM_NAME_MAX}
          className="min-h-12 rounded-xl border border-ink-muted bg-canvas px-4 text-lg"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink-muted">Quantity</span>
        <Stepper value={quantity} onChange={setQuantity} label="Quantity" />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={ids.notes}
          className="text-sm font-medium text-ink-muted"
        >
          Notes
        </label>
        <textarea
          id={ids.notes}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={NOTES_MAX}
          rows={3}
          className="rounded-xl border border-ink-muted bg-canvas px-4 py-2"
        />
      </div>
      <ul className="text-sm text-ink-muted">
        {users &&
          itemHistory(item, users).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={remove}
          className="min-h-11 rounded-lg px-3 font-medium text-danger hover:bg-accent-soft"
        >
          Delete
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={close}
          className="min-h-11 rounded-lg px-4 font-medium text-accent hover:bg-accent-soft"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-accent px-5 font-semibold text-accent-ink"
        >
          Save
        </button>
      </div>
    </form>
  );
}
