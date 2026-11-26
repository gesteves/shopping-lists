"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useList } from "@/client/hooks";
import { BackIcon } from "../../_components/icons";

/** One list. #9 adds the items and the add bar. */
export function ListView() {
  const { id } = useParams<{ id: string }>();
  const view = useList(id);

  return (
    <div className="mx-auto w-full max-w-2xl py-4 lg:py-6">
      <Link
        href="/"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 font-medium text-accent lg:hidden"
      >
        <BackIcon />
        Lists
      </Link>
      {view === undefined ? null : view === null ? (
        <p className="mt-4 text-lg text-ink-muted">
          This list doesn’t exist or was deleted.
        </p>
      ) : (
        <>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-balance break-words">
            {view.list.name}
          </h1>
          <p className="mt-2 text-ink-muted">
            {view.items.length === 0
              ? "Nothing on this list yet."
              : `${view.items.filter((i) => !i.checked).length} to get`}
          </p>
        </>
      )}
    </div>
  );
}
