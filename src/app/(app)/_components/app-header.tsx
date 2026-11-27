import Link from "next/link";
import { requireUser } from "@/lib/session";
import { SyncStarter } from "../sync-starter";
import { KeepScreenOn } from "./keep-screen-on";
import { SyncStatus } from "./sync-status";

/**
 * The top bar: the app name, sync status, "Keep screen on", settings, and
 * the avatar.
 */
export async function AppHeader() {
  const user = await requireUser();
  return (
    <>
      <SyncStarter userId={user.id} />
      <HeaderFrame>
        <SyncStatus />
        <KeepScreenOn />
        <Link
          href="/settings"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
        >
          <wa-icon name="gear"></wa-icon>
          Settings
        </Link>
        <Avatar name={user.name} image={user.image} />
      </HeaderFrame>
    </>
  );
}

/** The bar without the user, while the session loads. */
export function HeaderFrame({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex min-h-14 items-center justify-between gap-4 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
        <Link href="/" className="rounded-sm text-lg font-bold tracking-tight">
          Shopping Lists
        </Link>
        <div className="flex items-center gap-3">{children}</div>
      </div>
    </header>
  );
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  return (
    <wa-avatar
      image={image ?? undefined}
      initials={name.slice(0, 1).toUpperCase()}
      label={`Signed in as ${name}`}
      style={{ "--size": "2rem" }}
    ></wa-avatar>
  );
}
