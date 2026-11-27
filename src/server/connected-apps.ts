// "Connected apps" in settings (#18): the OAuth clients that a user
// approved, and the revoke. See "Authorization" in docs/PLAN.md.
import "server-only";
import { and, eq, max } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from "@/db/schema";
import { displayHost } from "@/lib/oauth";

export interface ConnectedApp {
  clientId: string;
  /** The name that the client gave. It is a claim, not a proof. */
  name: string | null;
  /** The client ID host (CIMD), or the host of the first redirect URI. */
  host: string;
  scopes: string[];
  connectedAt: number;
  /** The last token refresh, if there was one. */
  lastUsedAt: number | null;
}

function parseList(value: string | null): string[] {
  try {
    const list: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(list) ? list.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The apps that the user approved, the newest first. */
export function listConnectedApps(db: Db, userId: string): ConnectedApp[] {
  const lastRefresh = db
    .select({
      clientId: oauthRefreshTokens.clientId,
      at: max(oauthRefreshTokens.createdAt).as("at"),
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.userId, userId))
    .groupBy(oauthRefreshTokens.clientId)
    .as("last_refresh");

  const rows = db
    .select({
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
      createdAt: oauthConsents.createdAt,
      name: oauthClients.name,
      redirectUris: oauthClients.redirectUris,
      lastUsedAt: lastRefresh.at,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .leftJoin(lastRefresh, eq(lastRefresh.clientId, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, userId))
    .all();

  return rows
    .map((row) => ({
      clientId: row.clientId,
      name: row.name?.trim() || null,
      host: displayHost(
        row.clientId.startsWith("https://")
          ? row.clientId
          : (parseList(row.redirectUris)[0] ?? ""),
      ),
      scopes: parseList(row.scopes),
      connectedAt: row.createdAt.getTime(),
      // max() on a timestamp column gives the raw number.
      lastUsedAt: row.lastUsedAt === null ? null : Number(row.lastUsedAt),
    }))
    .sort((a, b) => b.connectedAt - a.connectedAt);
}

/**
 * Disconnects an app: deletes the grant, revokes the refresh tokens, and
 * deletes the opaque access tokens. The MCP endpoint rejects the JWT access
 * tokens of the app from now on, because the grant is gone. Returns false if
 * the user has no grant for the app.
 */
export function revokeConnectedApp(
  db: Db,
  userId: string,
  clientId: string,
  now: Date = new Date(),
): boolean {
  return db.transaction((tx) => {
    const deleted = tx
      .delete(oauthConsents)
      .where(
        and(
          eq(oauthConsents.userId, userId),
          eq(oauthConsents.clientId, clientId),
        ),
      )
      .run();
    tx.update(oauthRefreshTokens)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          eq(oauthRefreshTokens.clientId, clientId),
        ),
      )
      .run();
    tx.delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.userId, userId),
          eq(oauthAccessTokens.clientId, clientId),
        ),
      )
      .run();
    return deleted.changes > 0;
  });
}
