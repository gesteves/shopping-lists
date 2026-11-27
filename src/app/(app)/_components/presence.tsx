"use client";

import { initials } from "@/client/format";
import { usePresence, useUsers } from "@/client/hooks";
import { copy } from "@/copy";

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
    name: users?.get(id)?.name ?? copy.people.someone,
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
        <wa-avatar
          key={p.id}
          image={p.image ?? undefined}
          initials={initials(p.name)}
          label={copy.presence.viewing(p.name)}
          title={copy.presence.viewing(p.name)}
          className="ring-2 ring-surface"
          style={{ "--size": "1.5rem" }}
        ></wa-avatar>
      ))}
    </span>
  );
}

/** "Sam is editing…" when another person has this item open. */
export function EditingBadge({ itemId }: { itemId: string }) {
  const people = usePeople((_, editing) => editing === itemId);
  if (people.length === 0) return null;
  return (
    <wa-badge
      variant="brand"
      appearance="filled"
      pill
      attention="pulse"
      className="shrink-0 self-start"
    >
      {copy.item.editing(people.map((p) => p.name))}
    </wa-badge>
  );
}
