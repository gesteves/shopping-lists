"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { relativeTime } from "@/client/format";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import type { ConnectedApp } from "@/server/connected-apps";
import { disconnectApp } from "../../actions";
import { ConfirmDialog } from "../_components/wa";

/** The apps that can use the lists through MCP, with a disconnect (#18). */
export function ConnectedApps({ apps }: { apps: ConnectedApp[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<ConnectedApp | null>(null);

  async function disconnect(app: ConnectedApp) {
    setConfirming(null);
    const ok = await disconnectApp(app.clientId).catch(() => false);
    showToast({
      message: ok
        ? copy.settings.disconnected(app.name ?? app.host)
        : copy.settings.disconnectFailed,
    });
    router.refresh();
  }

  return (
    <section aria-labelledby="connected-apps" className="flex flex-col gap-3">
      <h2 id="connected-apps" className="text-xl font-semibold">
        {copy.settings.connectedApps}
      </h2>
      {apps.length === 0 ? (
        <p className="text-ink-muted">{copy.settings.noApps}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {apps.map((app) => {
            const label = app.name ?? app.host;
            return (
              <li
                key={app.clientId}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
              >
                <wa-icon name="plug" className="text-ink-muted"></wa-icon>
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{label}</p>
                  <p className="text-sm break-words text-ink-muted">
                    {copy.settings.appUsage(
                      app.host,
                      relativeTime(app.connectedAt),
                      app.lastUsedAt === null
                        ? null
                        : relativeTime(app.lastUsedAt),
                    )}
                  </p>
                </div>
                <wa-button
                  variant="danger"
                  appearance="plain"
                  onClick={() => setConfirming(app)}
                >
                  {copy.settings.disconnect}
                  <span className="sr-only"> {label}</span>
                </wa-button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirming !== null}
        label={copy.settings.disconnectTitle(
          confirming?.name ?? confirming?.host ?? "",
        )}
        confirmLabel={copy.settings.disconnect}
        danger
        onConfirm={() => confirming && void disconnect(confirming)}
        onClose={() => setConfirming(null)}
      >
        {copy.settings.disconnectBody}
      </ConfirmDialog>
    </section>
  );
}
