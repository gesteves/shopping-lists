import { describe, expect, it } from "vitest";
import { PRESENCE_TTL_MS, type PresenceSnapshot } from "@/shared/presence";
import { MAX_DEVICES_PER_USER, PresenceStore } from "./presence";

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

  it("keeps at most MAX_DEVICES_PER_USER devices for each person", () => {
    const { store, advance } = setup();
    store.set("ana", { clientId: "ana-1", listId: LIST, editingItemId: null });
    for (let i = 0; i < MAX_DEVICES_PER_USER + 5; i++) {
      advance(1);
      store.set("sam", {
        clientId: `d${i}`,
        listId: LIST,
        editingItemId: null,
      });
    }
    const entries = store.snapshot().entries;
    const sam = entries.filter((e) => e.userId === "sam");
    expect(sam).toHaveLength(MAX_DEVICES_PER_USER);
    // The newest devices stay. The other person keeps the device.
    expect(sam.map((e) => e.clientId)).toContain(
      `d${MAX_DEVICES_PER_USER + 4}`,
    );
    expect(sam.map((e) => e.clientId)).not.toContain("d0");
    expect(entries.filter((e) => e.userId === "ana")).toHaveLength(1);
  });

  it("removes the device with the oldest heartbeat to make room", () => {
    const { store, advance } = setup();
    for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
      advance(1);
      store.set("sam", {
        clientId: `d${i}`,
        listId: LIST,
        editingItemId: null,
      });
    }
    // A heartbeat of d0 makes d1 the oldest.
    store.set("sam", { clientId: "d0", listId: LIST, editingItemId: null });
    store.set("sam", { clientId: "new", listId: LIST, editingItemId: null });
    const ids = store.snapshot().entries.map((e) => e.clientId);
    expect(ids).toHaveLength(MAX_DEVICES_PER_USER);
    expect(ids).toContain("d0");
    expect(ids).toContain("new");
    expect(ids).not.toContain("d1");
  });
});
