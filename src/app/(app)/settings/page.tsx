import type { Metadata } from "next";
import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { getVapidConfig } from "@/server/push";
import { signOut } from "../../actions";
import { NotificationSettings } from "./notification-settings";

export const metadata: Metadata = { title: "Settings – Shopping Lists" };

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 py-6">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
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
      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-xl font-semibold">
          Account
        </h2>
        <form action={signOut} className="flex items-center gap-4">
          <p className="flex-1 text-ink-muted">Signed in as {user.name}</p>
          <wa-button type="submit" appearance="outlined">
            Sign out
          </wa-button>
        </form>
      </section>
    </>
  );
}
