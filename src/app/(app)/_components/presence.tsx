"use client";

import { usePresence, useUsers } from "@/client/hooks";

/** The other people who match `filter`, one each, with their names. */
function usePeople(
  filter: (listId: string | null, itemId: string | null) => boolean,
) {
  const users = useUsers();
  const entries = usePresence();
  const ids = [
    ...new Set(
      entries
        .filter((e) => filter(e.listId, e.editingItemId))
        .map((e) => e.userId),
    ),
  ];
  return ids.map((id) => ({
    id,
    name: users?.get(id)?.name ?? "Someone",
    image: users?.get(id)?.image ?? null,
  }));
}

/** An avatar dot for each other person who has this list open. */
export function ListViewers({ listId }: { listId: string }) {
  const people = usePeople((open) => open === listId);
  if (people.length === 0) return null;
  return (
    <span className="flex -space-x-1">
      {people.map((p) => (
        <span
          key={p.id}
          role="img"
          aria-label={`${p.name} has this list open`}
          title={`${p.name} has this list open`}
          className="grid size-6 place-items-center overflow-hidden rounded-full bg-accent text-xs font-semibold text-accent-ink ring-2 ring-surface"
        >
          {p.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.image}
              alt=""
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : (
            p.name.slice(0, 1).toUpperCase()
          )}
        </span>
      ))}
    </span>
  );
}

/** "Sam is editing…" when another person has this item open. */
export function EditingBadge({ itemId }: { itemId: string }) {
  const people = usePeople((_, editing) => editing === itemId);
  if (people.length === 0) return null;
  return (
    <span className="shrink-0 self-start animate-pulse rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent motion-reduce:animate-none">
      {people.map((p) => p.name).join(", ")} is editing…
    </span>
  );
}
