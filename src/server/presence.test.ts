import { describe, expect, it } from "vitest";
import { PRESENCE_TTL_MS, type PresenceSnapshot } from "@/shared/presence";
import { PresenceStore } from "./presence";

const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup() {
  let now = 1_000;
  const sent: PresenceSnapshot[] = [];
  const store = new PresenceStore({
    now: () => now,
    emit: (s) => sent.push(s),
  });
  return { store, sent, advance: (ms: number) => (now += ms) };
}

describe("PresenceStore", () => {
  it("broadcasts each change, and not a heartbeat with no change", () => {
    const { store, sent } = setup();
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: ITEM });
    expect(sent).toHaveLength(2);
    expect(sent[1].entries).toEqual([
      { userId: "sam", clientId: "phone", listId: LIST, editingItemId: ITEM },
    ]);
  });

  it("keeps each device of a person apart", () => {
    const { store } = setup();
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    store.set("sam", { clientId: "laptop", listId: null, editingItemId: ITEM });
    expect(store.snapshot().entries).toHaveLength(2);
  });

  it("removes a device that leaves", () => {
    const { store, sent } = setup();
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    store.set("sam", { clientId: "phone", listId: null, editingItemId: null });
    expect(sent.at(-1)?.entries).toEqual([]);
    // A second leave changes nothing.
    store.set("sam", { clientId: "phone", listId: null, editingItemId: null });
    expect(sent).toHaveLength(2);
  });

  it("expires a device with no heartbeat in the TTL", () => {
    const { store, sent, advance } = setup();
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    advance(PRESENCE_TTL_MS - 1);
    store.sweep();
    expect(store.snapshot().entries).toHaveLength(1);
    // A heartbeat extends it.
    store.set("sam", { clientId: "phone", listId: LIST, editingItemId: null });
    advance(PRESENCE_TTL_MS - 1);
    store.sweep();
    expect(store.snapshot().entries).toHaveLength(1);
    advance(1);
    expect(store.snapshot().entries).toEqual([]);
    store.sweep();
    expect(sent.at(-1)?.entries).toEqual([]);
  });
});
