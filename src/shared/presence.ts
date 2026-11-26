// The presence wire format (#12). This file imports only zod and shared
// files.
import { z } from "zod";
import { NODE_PATTERN } from "./hlc";

/** How long the server keeps a presence without a new heartbeat. */
export const PRESENCE_TTL_MS = 30_000;
/** How often the client sends its presence again. */
export const PRESENCE_HEARTBEAT_MS = 15_000;

/** POST /api/presence. Null for both means "this device left". */
export const presenceInputSchema = z.strictObject({
  clientId: z.string().regex(NODE_PATTERN),
  listId: z.uuid().nullable(),
  editingItemId: z.uuid().nullable(),
});

export type PresenceInput = z.infer<typeof presenceInputSchema>;

/** One device of one person, and what it shows. */
export interface PresenceEntry {
  userId: string;
  clientId: string;
  listId: string | null;
  editingItemId: string | null;
}

/** The `presence` SSE event: all devices that are present now. */
export interface PresenceSnapshot {
  entries: PresenceEntry[];
}
