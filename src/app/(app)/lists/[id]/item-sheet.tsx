"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { itemHistory } from "@/client/format";
import { useUsers } from "@/client/hooks";
import { mutate } from "@/client/sync";
import { useMedia } from "@/client/use-media";
import { copy } from "@/copy";
import { ITEM_NAME_MAX, NOTES_MAX } from "@/shared/ops";
import type { ItemRecord } from "@/shared/sync";
import { normalizeUrl } from "@/shared/url";
import { Stepper } from "../../_components/stepper";
import { UrlField, type UrlFieldHandle } from "../../_components/url-field";
import { useWaEvents } from "../../_components/wa";

/**
 * Edit an item: name, quantity, URL (#140), and notes, with who added and
 * changed it.
 * Move and Delete are in the menu of the row (#131), not here.
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
  // Each open gets a new form. Without this, a second open of the same item
  // kept the form of the first open, and a save compared the fields with
  // the old values (#140).
  const [opens, setOpens] = useState(item ? 1 : 0);
  const [open, setOpen] = useState(item !== null);
  if ((item !== null) !== open) {
    setOpen(item !== null);
    if (item) setOpens(opens + 1);
  }

  const ref = useWaEvents<HTMLElement>({
    "wa-after-hide": (event) => {
      // Only the sheet: the select in it fires its own hide events.
      if (event.target === event.currentTarget) onClose();
    },
  });

  const content = shown && (
    <SheetForm key={`${shown.id}:${opens}`} item={shown} onDone={onClose} />
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
  // The values when the sheet opened. A save sends only the fields that the
  // user changed, thus it keeps an edit of the other person in the meantime.
  const [initial] = useState(item);
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [notes, setNotes] = useState(item.notes);
  // A row from an older server has no url.
  const [url, setUrl] = useState(item.url ?? "");
  const urlField = useRef<UrlFieldHandle>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const link = normalizeUrl(url);
    if (link === undefined) {
      urlField.current?.reportValidity();
      return;
    }
    const fields: {
      name?: string;
      quantity?: number;
      notes?: string;
      url?: string;
    } = {};
    if (name.trim() && name.trim() !== initial.name) fields.name = name.trim();
    if (quantity !== initial.quantity) fields.quantity = quantity;
    if (link !== (initial.url ?? "")) fields.url = link;
    if (notes.trim() !== initial.notes.trim()) fields.notes = notes.trim();
    if (Object.keys(fields).length > 0) {
      await mutate({ type: "updateItem", args: { itemId: item.id, fields } });
    }
    onDone();
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
        <UrlField
          label={copy.itemSheet.url}
          placeholder={copy.itemSheet.urlPlaceholder}
          value={url}
          onChange={setUrl}
          handleRef={urlField}
        />
      </Field>
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
      <ul className="text-sm text-ink-muted">
        {users &&
          itemHistory(item, users).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex items-center justify-end gap-2">
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
