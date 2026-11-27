// The sync wire format: the push request, the op results, and the pull
// response. The client (#7) and the server both use it. This file imports
// only zod and other shared files.
import { z } from "zod";
import { NODE_PATTERN } from "./hlc";
import { opSchema, type Via } from "./ops";

/** The most ops in one push. The client sends more in a new push. */
export const MAX_PUSH_OPS = 200;
/** The largest push body, in bytes. */
export const MAX_PUSH_BYTES = 1_000_000;
/** The default and the largest page of a pull, in rows. */
export const PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

/** POST /api/sync/push. Each op must have the `clientId` of the request. */
export const pushRequestSchema = z
  .strictObject({
    clientId: z.string().regex(NODE_PATTERN),
    ops: z.array(opSchema).min(1).max(MAX_PUSH_OPS),
  })
  .refine((body) => body.ops.every((op) => op.clientId === body.clientId), {
    message: "Each op must have the clientId of the push",
    path: ["ops"],
  });

export type PushRequest = z.input<typeof pushRequestSchema>;

export type RejectReason =
  | "list_not_found"
  | "list_deleted"
  | "list_exists"
  | "item_not_found"
  | "item_exists"
  /** The op HLC is too far after the server clock (MAX_DRIFT_MS). */
  | "clock_ahead"
  /** A different user sent an op with this opId first. */
  | "op_conflict";

/** The result of an op, as processed_ops keeps it. */
export type StoredResult =
  | {
      opId: string;
      status: "applied";
      changed: boolean;
      /**
       * clearChecked, uncheckAll, checkAll: the items that the op changed.
       * deleteList: the live items of the list. Only when `changed`.
       */
      count?: number;
    }
  /** addItem found an item with the same name. The client drops its row. */
  | { opId: string; status: "merged"; into: string; changed: boolean }
  | { opId: string; status: "rejected"; reason: RejectReason };

export type OpResult =
  | StoredResult
  /** The server applied this opId before. `original` is the first result. */
  | { opId: string; status: "duplicate"; original: StoredResult };

export interface PushResponse {
  /** One result for each op, in the same order. */
  results: OpResult[];
  /** The last seq of the push, or null if no row changed. */
  seq: number | null;
  /**
   * The server time in ms. The client keeps the offset to its own clock, and
   * uses it to stamp again an op with a `clock_ahead` rejection.
   */
  now: number;
}

/**
 * GET /api/sync/pull query: `since` is the cursor of the client. `seen` is
 * the last `purgedSeq` that the client got. A client that got it after its
 * last reset needs no new reset.
 */
export const pullQuerySchema = z.strictObject({
  since: z.coerce.number().int().min(0).default(0),
  seen: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(PULL_LIMIT),
});

// Times are milliseconds since the epoch.

export interface ListRecord {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  updatedVia: Via;
  deletedAt: number | null;
  /** A one-line summary of the unchecked items, from Claude, or null. */
  summary: string | null;
  seq: number;
}

export interface ItemRecord {
  id: string;
  listId: string;
  name: string;
  quantity: number;
  notes: string;
  checked: boolean;
  checkedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  updatedVia: Via;
  deletedAt: number | null;
  seq: number;
}

export interface UserRecord {
  id: string;
  /** The Google given name. */
  name: string;
  image: string | null;
}

export interface PullResponse {
  /**
   * True if the client must delete its lists and items (not its outbox)
   * before it applies this page. The server then sends all rows from seq 0.
   * This occurs after a purge of old tombstones, or when the server database
   * is older than the cursor (a restore from a backup).
   */
  reset: boolean;
  /** Rows with a seq after the cursor, tombstones included. */
  lists: ListRecord[];
  items: ItemRecord[];
  /** All users, for the names and avatars. */
  users: UserRecord[];
  /** The largest field clock in this page, or null. Give it to the HLC clock. */
  hlc: string | null;
  /** The `since` of the next pull. */
  cursor: number;
  /** True if there are more rows. Pull again now with the new cursor. */
  hasMore: boolean;
  /**
   * The largest seq that the server purged. The client keeps it, and sends
   * it as `seen` with each pull.
   */
  purgedSeq: number;
  /** The server time in ms. The client keeps the offset to its own clock. */
  now: number;
}
