import { afterEach, describe, expect, it } from "vitest";
import { PRESENCE_HEARTBEAT_MS } from "@/shared/presence";
import { reportPresence, startPresence } from "./presence";

const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  reportPresence({ listId: null, editingItemId: null });
});

function setup() {
  const doc = new FakeDocument();
  const sent: unknown[] = [];
  let tick: (() => void) | undefined;
  let tickMs = 0;
  stop = startPresence({
    clientId: "phone",
    document: doc as unknown as Document,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
    setInterval: (fn, ms) => {
      tick = fn;
      tickMs = ms;
      return 1;
    },
    clearInterval: () => (tick = undefined),
  });
  return { doc, sent, tick: () => tick?.(), tickMs: () => tickMs };
}

describe("presence reporting", () => {
  it("sends each change, and nothing for the same state again", () => {
    const { sent } = setup();
    reportPresence({ listId: LIST, editingItemId: null });
    reportPresence({ listId: LIST, editingItemId: null });
    reportPresence({ listId: LIST, editingItemId: ITEM });
    expect(sent).toEqual([
      { clientId: "phone", listId: LIST, editingItemId: null },
      { clientId: "phone", listId: LIST, editingItemId: ITEM },
    ]);
  });

  it("sends a heartbeat only while a list is open", () => {
    const { sent, tick, tickMs } = setup();
    expect(tickMs()).toBe(PRESENCE_HEARTBEAT_MS);
    tick();
    expect(sent).toHaveLength(0);
    reportPresence({ listId: LIST, editingItemId: null });
    tick();
    expect(sent).toHaveLength(2);
  });

  it("clears when the page is hidden, and comes back when visible", () => {
    const { doc, sent } = setup();
    reportPresence({ listId: LIST, editingItemId: null });
    doc.set("hidden");
    reportPresence({ listId: LIST, editingItemId: ITEM }); // Not sent.
    doc.set("visible");
    expect(sent).toEqual([
      { clientId: "phone", listId: LIST, editingItemId: null },
      { clientId: "phone", listId: null, editingItemId: null },
      { clientId: "phone", listId: LIST, editingItemId: ITEM },
    ]);
  });

  it("clears when it stops", () => {
    const { sent } = setup();
    reportPresence({ listId: LIST, editingItemId: null });
    stop?.();
    stop = undefined;
    expect(sent.at(-1)).toEqual({
      clientId: "phone",
      listId: null,
      editingItemId: null,
    });
  });
});
