"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { itemHistory } from "@/client/format";
import { useLists, useUsers } from "@/client/hooks";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { useMedia } from "@/client/use-media";
import { copy } from "@/copy";
import { ITEM_NAME_MAX, NOTES_MAX } from "@/shared/ops";
import type { ItemRecord } from "@/shared/sync";
import { Stepper } from "../../_components/stepper";
import { useWaEvents } from "../../_components/wa";

/**
 * Edit an item: name, quantity, and notes, with who added and changed it.
 * A bottom drawer on a phone, a dialog on a large screen. Neither focuses
 * the name field when it opens, so a phone does not open the keyboard.
 */
export function ItemSheet({
  item,
  onClose,
}: {
  item: ItemRecord | null;
  onClose: () => void;
}) {
  const large = useMedia("(min-width: 64rem)");
  // Keep the last item while the sheet closes, so its content stays.
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);

  const ref = useWaEvents<HTMLElement>({
    "wa-after-hide": (event) => {
      // Only the sheet: the select in it fires its own hide events.
      if (event.target === event.currentTarget) onClose();
    },
  });

  const content = shown && (
    <SheetForm key={shown.id} item={shown} onDone={onClose} />
  );
  return large ? (
    <wa-dialog
      ref={ref}
      open={item !== null}
      label={copy.itemSheet.title}
      light-dismiss
    >
      {content}
    </wa-dialog>
  ) : (
    <wa-drawer
      ref={ref}
      open={item !== null}
      label={copy.itemSheet.title}
      placement="bottom"
      light-dismiss
      style={{ "--size": "auto" }}
    >
      {content}
    </wa-drawer>
  );
}

function Field({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

function SheetForm({ item, onDone }: { item: ItemRecord; onDone: () => void }) {
  const users = useUsers();
  const lists = useLists();
  const others = lists?.filter((l) => l.id !== item.listId) ?? [];
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [notes, setNotes] = useState(item.notes);

  async function save(event: FormEvent) {
    event.preventDefault();
    const fields: { name?: string; quantity?: number; notes?: string } = {};
    if (name.trim() && name.trim() !== item.name) fields.name = name.trim();
    if (quantity !== item.quantity) fields.quantity = quantity;
    if (notes.trim() !== item.notes) fields.notes = notes.trim();
    if (Object.keys(fields).length > 0) {
      await mutate({ type: "updateItem", args: { itemId: item.id, fields } });
    }
    onDone();
  }

  async function remove() {
    await mutate({ type: "deleteItem", args: { itemId: item.id } });
    onDone();
    showToast({
      message: copy.itemSheet.deleted(item.name),
      action: {
        label: copy.common.undo,
        run: () =>
          void mutate({ type: "restoreItem", args: { itemId: item.id } }),
      },
    });
  }

  async function move(toListId: string) {
    const target = lists?.find((l) => l.id === toListId);
    if (!target) return;
    await mutate({ type: "moveItem", args: { itemId: item.id, toListId } });
    onDone();
    showToast({
      message: copy.itemSheet.moved(item.name, target.name),
      action: {
        label: copy.common.undo,
        run: () =>
          void mutate({
            type: "moveItem",
            args: { itemId: item.id, toListId: item.listId },
          }),
      },
    });
  }

  return (
    <form
      onSubmit={save}
      className="flex flex-col gap-5 pb-[env(safe-area-inset-bottom)]"
    >
      <Field>
        <wa-input
          label={copy.itemSheet.name}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          required
          maxlength={ITEM_NAME_MAX}
        ></wa-input>
      </Field>
      <div className="flex items-center justify-between gap-3">
        <Stepper
          value={quantity}
          onChange={setQuantity}
          label={copy.itemSheet.quantity}
        />
      </div>
      <Field>
        <wa-textarea
          label={copy.itemSheet.notes}
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
          maxlength={NOTES_MAX}
          rows={3}
          resize="auto"
        ></wa-textarea>
      </Field>
      {others.length > 0 && (
        <wa-select
          label={copy.itemSheet.moveTo}
          placeholder={copy.itemSheet.pickList}
          value=""
          onChange={(e) => void move((e.target as HTMLSelectElement).value)}
        >
          {others.map((l) => (
            <wa-option key={l.id} value={l.id}>
              {l.name}
            </wa-option>
          ))}
        </wa-select>
      )}
      <ul className="text-sm text-ink-muted">
        {users &&
          itemHistory(item, users).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex items-center gap-2">
        <wa-button variant="danger" appearance="plain" onClick={remove}>
          <wa-icon slot="start" name="trash-can"></wa-icon>
          {copy.common.delete}
        </wa-button>
        <span className="flex-1" />
        <wa-button appearance="plain" onClick={onDone}>
          {copy.common.cancel}
        </wa-button>
        <wa-button type="submit" variant="brand">
          {copy.common.save}
        </wa-button>
      </div>
    </form>
  );
}
