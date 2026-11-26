import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { SessionRefresh } from "../session-refresh";
import { SyncStarter } from "./sync-starter";

// The signed-in part of the app. Ticket #8 adds the shell.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SessionRefresh />
      <Suspense>
        <StartSync />
      </Suspense>
      {children}
    </>
  );
}

async function StartSync() {
  const user = await requireUser();
  return <SyncStarter userId={user.id} />;
}
