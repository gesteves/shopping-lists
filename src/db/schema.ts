// Drizzle schema. After a change, run `npm run db:generate`.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
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

// The OAuth server for MCP clients (#18): the Better Auth JWT plugin and
// the OAuth provider of @better-auth/mcp. See "Authorization" in
// docs/PLAN.md. The adapter writes `string[]` and `json` fields as JSON
// text itself, thus these columns are plain text (no drizzle JSON mode).

const json = (name: string) => text(name);
const date = (name: string) => integer(name, { mode: "timestamp_ms" });

/** The signing keys of the access tokens. */
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: date("created_at").notNull(),
  expiresAt: date("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    /** A random ID (DCR), or the HTTPS URL of a metadata document (CIMD). */
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    /** "cimd" for a client from a metadata document. */
    clientDiscoveryId: text("client_discovery_id"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: json("scopes"),
    clientCredentialsScopes: json("client_credentials_scopes").default("[]"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: json("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: json("redirect_uris").notNull(),
    postLogoutRedirectUris: json("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer(
      "backchannel_logout_session_required",
      { mode: "boolean" },
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: json("grant_types"),
    responseTypes: json("response_types"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", {
      mode: "boolean",
    }).default(false),
    referenceId: text("reference_id"),
    metadata: json("metadata"),
  },
  (t) => [index("oauth_clients_user_id_idx").on(t.userId)],
);

/** A protected resource: the /mcp endpoint. */
export const oauthResources = sqliteTable("oauth_resources", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: json("allowed_scopes"),
  customClaims: json("custom_claims"),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", {
    mode: "boolean",
  }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: date("created_at"),
  updatedAt: date("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: json("metadata"),
});

/** The resources that each client can get tokens for. */
export const oauthClientResources = sqliteTable(
  "oauth_client_resources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: json("metadata"),
    createdAt: date("created_at"),
  },
  (t) => [
    index("oauth_client_resources_client_id_idx").on(t.clientId),
    index("oauth_client_resources_resource_id_idx").on(t.resourceId),
    uniqueIndex("oauth_client_resources_pair_idx").on(t.clientId, t.resourceId),
  ],
);

/** Refresh tokens (hashed). Each refresh rotates the token. */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: json("resources"),
    requestedUserInfoClaims: json("requested_user_info_claims"),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull(),
    revoked: date("revoked"),
    rotatedAt: date("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: date("rotation_replay_expires_at"),
    authTime: date("auth_time"),
    confirmation: json("confirmation"),
    scopes: json("scopes").notNull(),
  },
  (t) => [
    index("oauth_refresh_tokens_client_id_idx").on(t.clientId),
    index("oauth_refresh_tokens_session_id_idx").on(t.sessionId),
    index("oauth_refresh_tokens_user_id_idx").on(t.userId),
    index("oauth_refresh_tokens_code_id_idx").on(t.authorizationCodeId),
  ],
);

/** Opaque access tokens (hashed). MCP tokens are JWTs and are not stored. */
export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: json("resources"),
    requestedUserInfoClaims: json("requested_user_info_claims"),
    refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
      onDelete: "cascade",
    }),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull(),
    revoked: date("revoked"),
    confirmation: json("confirmation"),
    scopes: json("scopes").notNull(),
  },
  (t) => [
    index("oauth_access_tokens_client_id_idx").on(t.clientId),
    index("oauth_access_tokens_session_id_idx").on(t.sessionId),
    index("oauth_access_tokens_user_id_idx").on(t.userId),
    index("oauth_access_tokens_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_tokens_refresh_id_idx").on(t.refreshId),
  ],
);

/**
 * The grants that a user gave to a client. The MCP endpoint accepts a
 * token only while its grant exists (src/server/mcp/auth.ts).
 */
export const oauthConsents = sqliteTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    resources: json("resources"),
    requestedUserInfoClaims: json("requested_user_info_claims"),
    scopes: json("scopes").notNull(),
    createdAt: date("created_at").notNull(),
    updatedAt: date("updated_at").notNull(),
  },
  (t) => [
    index("oauth_consents_client_id_idx").on(t.clientId),
    index("oauth_consents_user_id_idx").on(t.userId),
  ],
);

/** Single-use `private_key_jwt` assertion IDs. */
export const oauthClientAssertions = sqliteTable("oauth_client_assertions", {
  id: text("id").primaryKey(),
  expiresAt: date("expires_at").notNull(),
});

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
    /** The server time of the delete. The purge uses it (#101). */
    tombstonedAt: integer("tombstoned_at", { mode: "timestamp_ms" }),
    clocks: text("clocks", { mode: "json" })
      .$type<ListClocks>()
      .notNull()
      .default({}),
    /**
     * A one-line summary of the unchecked items, from Claude. Only the
     * summary worker (src/server/summary/) writes it. Null if there is none.
     */
    summary: text("summary"),
    /** summaryKey() of the items that `summary` tells about. */
    summaryKey: text("summary_key"),
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
    /** An http or https URL (#140). An empty string means no link. */
    url: text("url").notNull().default(""),
    checked: integer("checked", { mode: "boolean" }).notNull().default(false),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    /**
     * The op time when someone marked the item out of stock (#131). Null if
     * it is in stock.
     */
    outOfStockAt: integer("out_of_stock_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull().references(userRef),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedBy: text("updated_by").notNull().references(userRef),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    updatedVia: text("updated_via", { enum: VIA }).notNull().default("app"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /** The server time of the delete. The purge uses it (#101). */
    tombstonedAt: integer("tombstoned_at", { mode: "timestamp_ms" }),
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
  /** renameList and updateItem: the name before. */
  oldName?: string;
  /** moveItem: the name of the list before. */
  fromListName?: string;
  /**
   * clearChecked, uncheckAll, and checkAll: the number of items they changed.
   * Only older rows have it: newer rows have one row for each item (#133).
   */
  count?: number;
  /** updateItem: the fields that changed (#89). Older rows do not have it. */
  fields?: ItemField[];
  /**
   * updateItem, moveItem, and markOutOfStock: the change also unchecked the
   * item (#112, #131). addItem: the name was on the list, and the add only
   * unchecked the item (#133).
   */
  unchecked?: boolean;
  /**
   * check, checkAll, and moveItem: the change also marked the item in stock
   * (#131).
   */
  inStock?: boolean;
  // The values below are only for collapse (#133). They do not go to the
  // push text or to Claude. Older rows do not have them.
  /**
   * The quantity, the notes, and the URL after the change: updateItem
   * (only the fields that changed), addItem, and deleteItem (the item
   * before the delete). Rows from before #140 have no URL.
   */
  quantity?: number;
  notes?: string;
  url?: string;
  /** updateItem: the quantity, the notes, and the URL before, if they changed. */
  oldQuantity?: number;
  oldNotes?: string;
  oldUrl?: string;
  /** deleteItem: the item was checked, or out of stock. */
  checked?: boolean;
  outOfStock?: boolean;
}

/** The fields that updateItem can change. */
export type ItemField = "name" | "quantity" | "notes" | "url";

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
    /** The failed pushes since the last success (#118). */
    failureCount: integer("failure_count").notNull().default(0),
    /** The first failure since the last success. */
    failingSince: integer("failing_since", { mode: "timestamp_ms" }),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
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
