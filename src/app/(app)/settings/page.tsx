import type { Metadata } from "next";
import { Suspense } from "react";
import { copy } from "@/copy";
import { mcpResource } from "@/lib/oauth";
import { requireUser } from "@/lib/session";
import { getDb } from "@/db/client";
import { listConnectedApps } from "@/server/connected-apps";
import { getVapidConfig } from "@/server/push";
import { signOut } from "../../actions";
import { KeepScreenOnSetting } from "../_components/keep-screen-on";
import { ConnectedApps } from "./connected-apps";
import { NotificationSettings } from "./notification-settings";

export const metadata: Metadata = {
  title: copy.app.pageTitle(copy.settings.title),
};

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 py-6">
      <h1 className="text-3xl font-bold tracking-tight">
        {copy.settings.title}
      </h1>
      <Suspense>
        <Settings />
      </Suspense>
    </div>
  );
}

async function Settings() {
  const user = await requireUser();
  // The public key only. The private key stays on the server.
  const publicKey = getVapidConfig()?.publicKey ?? null;
  return (
    <>
      <NotificationSettings publicKey={publicKey} />
      <KeepScreenOnSetting />
      <ConnectedApps
        apps={listConnectedApps(getDb(), user.id)}
        mcpUrl={mcpResource()}
      />
      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-xl font-semibold">
          {copy.settings.account}
        </h2>
        <form action={signOut} className="flex items-center gap-4">
          <p className="flex-1 text-ink-muted">
            {copy.settings.signedInAs(user.name)}
          </p>
          <wa-button type="submit" appearance="outlined">
            {copy.settings.signOut}
          </wa-button>
        </form>
      </section>
    </>
  );
}
