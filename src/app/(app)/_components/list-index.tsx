"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { useListSummaries } from "@/client/hooks";
import type { ListSummary } from "@/client/queries";
import { mutate } from "@/client/sync";
import { LIST_NAME_MAX } from "@/shared/ops";
import { MoreIcon, PlusIcon } from "./icons";

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
        Lists
      </Heading>
      {lists === undefined ? null : lists.length === 0 ? (
        <p className="px-1 text-ink-muted">
          No lists yet. Make one for each store you go to.
        </p>
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

function remainingText(n: number) {
  return n === 0 ? "Nothing to get" : `${n} to get`;
}

function ListRow({ list }: { list: ListSummary }) {
  const pathname = usePathname();
  const href = `/lists/${list.id}`;
  const current = pathname === href;
  const [mode, setMode] = useState<"view" | "actions" | "rename">("view");
  const dialog = useRef<HTMLDialogElement>(null);
  const actionsId = useId();

  if (mode === "rename") {
    return (
      <li>
        <RenameForm list={list} onDone={() => setMode("view")} />
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-line bg-surface">
      <div className="flex items-stretch">
        <Link
          href={href}
          aria-current={current ? "page" : undefined}
          className={`flex min-h-16 flex-1 flex-col justify-center rounded-xl px-4 py-2 ${current ? "bg-accent-soft" : ""}`}
        >
          <span className="text-xl leading-tight font-semibold text-balance break-words">
            {list.name}
          </span>
          <span className="text-sm text-ink-muted tabular-nums">
            {remainingText(list.remaining)}
          </span>
        </Link>
        <button
          type="button"
          aria-expanded={mode === "actions"}
          aria-controls={actionsId}
          aria-label={`More for ${list.name}`}
          onClick={() => setMode(mode === "actions" ? "view" : "actions")}
          className="grid min-w-12 place-items-center rounded-xl text-ink-muted hover:text-ink"
        >
          <MoreIcon />
        </button>
      </div>
      {mode === "actions" && (
        <div
          id={actionsId}
          className="flex gap-2 border-t border-line px-3 py-2"
        >
          <button
            type="button"
            onClick={() => setMode("rename")}
            className="min-h-11 rounded-lg px-3 font-medium text-accent hover:bg-accent-soft"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => dialog.current?.showModal()}
            className="min-h-11 rounded-lg px-3 font-medium text-danger hover:bg-accent-soft"
          >
            Delete
          </button>
        </div>
      )}
      <DeleteDialog
        ref={dialog}
        list={list}
        onDeleted={() => setMode("view")}
      />
    </li>
  );
}

function DeleteDialog({
  ref,
  list,
  onDeleted,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  list: ListSummary;
  onDeleted: () => void;
}) {
  const titleId = useId();
  async function confirm() {
    ref.current?.close();
    await mutate({ type: "deleteList", args: { listId: list.id } });
    onDeleted();
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/40"
    >
      <h2 id={titleId} className="text-xl font-semibold text-balance">
        Delete the “{list.name}” list?
      </h2>
      <p className="mt-2 text-ink-muted">
        {list.remaining > 0
          ? `It has ${list.remaining} ${list.remaining === 1 ? "item" : "items"} to get. The other person loses it too.`
          : "The other person loses it too."}
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="min-h-11 rounded-lg px-4 font-medium text-accent hover:bg-accent-soft"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          className="min-h-11 rounded-lg bg-danger px-4 font-semibold text-surface"
        >
          Delete list
        </button>
      </div>
    </dialog>
  );
}

function RenameForm({
  list,
  onDone,
}: {
  list: ListSummary;
  onDone: () => void;
}) {
  const [name, setName] = useState(list.name);
  const inputId = useId();

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
      className="flex flex-col gap-2 rounded-xl border border-accent bg-surface p-3"
    >
      <label htmlFor={inputId} className="text-sm font-medium text-ink-muted">
        New name for “{list.name}”
      </label>
      <input
        id={inputId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={LIST_NAME_MAX}
        required
        autoFocus
        enterKeyHint="done"
        className="min-h-11 rounded-lg border border-ink-muted bg-canvas px-3 text-lg"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-lg px-3 font-medium text-accent hover:bg-accent-soft"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-accent-ink"
        >
          Save
        </button>
      </div>
    </form>
  );
}

function CreateListForm() {
  const [name, setName] = useState("");
  const inputId = useId();

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
    <form onSubmit={submit} className="flex gap-2">
      <label htmlFor={inputId} className="sr-only">
        New list name
      </label>
      <input
        id={inputId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New list"
        maxLength={LIST_NAME_MAX}
        enterKeyHint="go"
        autoComplete="off"
        className="min-h-12 min-w-0 flex-1 rounded-xl border border-ink-muted bg-surface px-4 text-lg placeholder:text-ink-muted"
      />
      <button
        type="submit"
        disabled={!name.trim()}
        className="flex min-h-12 items-center gap-1 rounded-xl bg-accent px-4 font-semibold text-accent-ink disabled:opacity-50"
      >
        <PlusIcon />
        Create
      </button>
    </form>
  );
}
