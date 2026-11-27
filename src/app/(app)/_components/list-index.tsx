"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useListSummaries } from "@/client/hooks";
import type { ListSummary } from "@/client/queries";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { LIST_NAME_MAX } from "@/shared/ops";
import { ListViewers } from "./presence";
import { ConfirmDialog, useWaEvents } from "./wa";

/**
 * The lists, with create, rename, and delete. The page `/` shows it on a
 * phone. On a large screen it is the sidebar.
 */
export function ListIndex({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  const lists = useListSummaries();
  const Heading = `h${headingLevel}` as const;

  return (
    <section aria-labelledby="lists-heading" className="flex flex-col gap-4">
      <Heading
        id="lists-heading"
        className="px-1 text-3xl font-bold tracking-tight lg:text-xl"
      >
        {copy.lists.heading}
      </Heading>
      {lists === undefined ? null : lists.length === 0 ? (
        <p className="px-1 text-ink-muted">{copy.lists.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lists.map((list) => (
            <ListRow key={list.id} list={list} />
          ))}
        </ul>
      )}
      <CreateListForm />
    </section>
  );
}

function ListRow({ list }: { list: ListSummary }) {
  const pathname = usePathname();
  const href = `/lists/${list.id}`;
  const current = pathname === href;
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const menu = useWaEvents<HTMLElement>({
    "wa-select": (event) => {
      const value = (event as CustomEvent<{ item: { value: string } }>).detail
        .item.value;
      if (value === "rename") setRenaming(true);
      if (value === "delete") setDeleting(true);
    },
  });

  if (renaming) {
    return (
      <li>
        <RenameForm list={list} onDone={() => setRenaming(false)} />
      </li>
    );
  }

  return (
    // The open list: the whole card is green, with a green border.
    <li
      className={`rounded-xl border ${current ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-line bg-surface"}`}
    >
      <div className="flex items-center">
        <Link
          href={href}
          aria-current={current ? "page" : undefined}
          className="flex min-h-16 flex-1 flex-col justify-center self-stretch rounded-xl px-4 py-2"
        >
          <span className="text-xl leading-tight font-semibold text-balance break-words">
            {list.name}
          </span>
          <span className="flex items-center gap-2 text-sm text-ink-muted tabular-nums">
            {copy.lists.remaining(list.remaining)}
            <ListViewers listId={list.id} />
          </span>
        </Link>
        {/* <wa-dropdown> is display: contents. The button is the flex item. */}
        <wa-dropdown ref={menu} placement="bottom-end">
          <wa-button
            slot="trigger"
            appearance="plain"
            size="l"
            className="me-2"
          >
            <wa-icon
              name="ellipsis"
              label={copy.lists.more(list.name)}
            ></wa-icon>
          </wa-button>
          <wa-dropdown-item value="rename">
            <wa-icon slot="icon" name="pen"></wa-icon>
            {copy.common.rename}
          </wa-dropdown-item>
          <wa-divider></wa-divider>
          <wa-dropdown-item value="delete" variant="danger">
            <wa-icon slot="icon" name="trash-can"></wa-icon>
            {copy.common.delete}
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
      <DeleteDialog
        open={deleting}
        list={list}
        onClose={() => setDeleting(false)}
      />
    </li>
  );
}

/** Asks before a list delete, then offers Undo. */
export function DeleteDialog({
  open,
  list,
  onClose,
  onDeleted,
}: {
  open: boolean;
  list: Pick<ListSummary, "id" | "name" | "remaining">;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  async function confirm() {
    onClose();
    await mutate({ type: "deleteList", args: { listId: list.id } });
    onDeleted?.();
    showToast({
      message: copy.lists.deleted(list.name),
      action: {
        label: copy.common.undo,
        run: () =>
          void mutate({ type: "restoreList", args: { listId: list.id } }),
      },
    });
  }
  return (
    <ConfirmDialog
      open={open}
      label={copy.lists.deleteTitle(list.name)}
      confirmLabel={copy.lists.deleteConfirm}
      danger
      onConfirm={confirm}
      onClose={onClose}
    >
      {copy.lists.deleteBody(list.remaining)}
    </ConfirmDialog>
  );
}

/** Rename a list inline. The list index and the list header use it. */
export function RenameForm({
  list,
  onDone,
}: {
  list: Pick<ListSummary, "id" | "name">;
  onDone: () => void;
}) {
  const [name, setName] = useState(list.name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed && trimmed !== list.name) {
      await mutate({
        type: "renameList",
        args: { listId: list.id, name: trimmed },
      });
    }
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
      className="flex flex-col gap-3 rounded-xl border border-accent bg-surface p-3"
    >
      <wa-input
        label={copy.lists.renameLabel(list.name)}
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        maxlength={LIST_NAME_MAX}
        required
        autofocus
        enterkeyhint="done"
      ></wa-input>
      <div className="flex justify-end gap-2">
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

function CreateListForm() {
  const [name, setName] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Clear first: text typed while the write runs must stay.
    setName("");
    await mutate({
      type: "createList",
      args: { listId: crypto.randomUUID(), name: trimmed },
    });
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <wa-input
        className="wa-sr-label min-w-0 flex-1"
        label={copy.lists.newName}
        placeholder={copy.lists.newPlaceholder}
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        maxlength={LIST_NAME_MAX}
        enterkeyhint="go"
        autocomplete="off"
        size="l"
      ></wa-input>
      <wa-button type="submit" variant="brand" size="l" disabled={!name.trim()}>
        <wa-icon slot="start" name="plus"></wa-icon>
        {copy.lists.create}
      </wa-button>
    </form>
  );
}
