// Drizzle schema. After a change, run `npm run db:generate`.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { ItemClocks, ListClocks, OpType } from "../shared/ops";
import { VIA } from "../shared/ops";

const now = sql`(unixepoch() * 1000)`;

// Better Auth tables. The property names must match the Better Auth field
// names. The column names can be different.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** The Google given name. */
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  /** The Google avatar URL. */
  image: text("avatar_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// App tables. See "Data model" and "Sync design" in docs/PLAN.md.
//
// Rules for lists and items:
//   - The client makes the ID (a UUID), thus an offline device can make rows.
//   - A delete sets `deleted_at` (a tombstone). Sync sends tombstones too.
//   - `clocks` has one serialized HLC for each field (ListClocks, ItemClocks).
//     The merge in applyOps (#5) writes a field only if the op is newer.
//   - `seq` is the value of `server_seq` at the last write. A pull sends the
//     rows with `seq` larger than the cursor of the client.

const userRef = () => users.id;

export const lists = sqliteTable(
  "lists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull().references(userRef),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedBy: text("updated_by").notNull().references(userRef),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    updatedVia: text("updated_via", { enum: VIA }).notNull().default("app"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    clocks: text("clocks", { mode: "json" })
      .$type<ListClocks>()
      .notNull()
      .default({}),
    seq: integer("seq").notNull(),
  },
  (t) => [index("lists_seq_idx").on(t.seq)],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** nameKey(name), from src/shared/names.ts. */
    nameKey: text("name_key").notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** An empty string means no notes. */
    notes: text("notes").notNull().default(""),
    checked: integer("checked", { mode: "boolean" }).notNull().default(false),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull().references(userRef),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedBy: text("updated_by").notNull().references(userRef),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    updatedVia: text("updated_via", { enum: VIA }).notNull().default("app"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    clocks: text("clocks", { mode: "json" })
      .$type<ItemClocks>()
      .notNull()
      .default({}),
    seq: integer("seq").notNull(),
  },
  (t) => [
    index("items_seq_idx").on(t.seq),
    // Also covers the queries on list_id only.
    index("items_list_id_name_key_idx").on(t.listId, t.nameKey),
    // Autocomplete (#14) reads the names of all lists.
    index("items_name_key_idx").on(t.nameKey),
  ],
);

/**
 * The opIds that the server applied. A retry of a push sends the same opId,
 * and the server gives the stored result again.
 */
export const processedOps = sqliteTable(
  "processed_ops",
  {
    opId: text("op_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(userRef, { onDelete: "cascade" }),
    /** The result that the push gave for this op (#5, #6). */
    result: text("result", { mode: "json" }).$type<unknown>(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("processed_ops_processed_at_idx").on(t.processedAt)],
);

/** The names in an activity row, at the time of the change. */
export interface ActivitySnapshot {
  listName: string;
  itemName?: string;
  /** renameList: the name before. */
  oldName?: string;
  /** moveItem: the name of the list before. */
  fromListName?: string;
  /** clearChecked and uncheckAll: the number of items they changed. */
  count?: number;
}

/** One row for each change. The notifier (#16) sends them. */
export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    opId: text("op_id"),
    actorId: text("actor_id")
      .notNull()
      .references(userRef, { onDelete: "cascade" }),
    via: text("via", { enum: VIA }).notNull(),
    type: text("type").$type<OpType>().notNull(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => items.id, { onDelete: "cascade" }),
    snapshot: text("snapshot", { mode: "json" })
      .$type<ActivitySnapshot>()
      .notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // The notifier reads only the rows that it did not send.
    index("activity_pending_idx")
      .on(t.actorId, t.at)
      .where(sql`${t.notifiedAt} IS NULL`),
    index("activity_list_id_idx").on(t.listId),
  ],
);

/** One row for each browser that allows push (#15). */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(userRef, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    /** The `keys` of the PushSubscription. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.userId)],
);

/** A user gets no push for a list that they muted. */
export const listMutes = sqliteTable(
  "list_mutes",
  {
    userId: text("user_id")
      .notNull()
      .references(userRef, { onDelete: "cascade" }),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.listId] }),
    index("list_mutes_list_id_idx").on(t.listId),
  ],
);

/**
 * One row (id 1) with the last seq. There is no seed row. To get the next
 * seq, in the write transaction:
 *   INSERT INTO server_seq (id, value) VALUES (1, 1)
 *   ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value
 */
export const serverSeq = sqliteTable(
  "server_seq",
  {
    id: integer("id").primaryKey(),
    value: integer("value").notNull(),
    /**
     * The largest seq of a row that purgeTombstones deleted. A client with a
     * cursor below it can miss a delete, thus it must pull again from 0 (#6).
     */
    purgedSeq: integer("purged_seq").notNull().default(0),
  },
  (t) => [check("server_seq_one_row", sql`${t.id} = 1`)],
);
