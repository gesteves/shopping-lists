import Link from "next/link";
import { requireUser } from "@/lib/session";
import { SyncStarter } from "../sync-starter";
import { SyncStatus } from "./sync-status";

/** The top bar: the app name, sync status, settings, and the avatar. */
export async function AppHeader() {
  const user = await requireUser();
  return (
    <>
      <SyncStarter userId={user.id} />
      <HeaderFrame>
        <SyncStatus />
        <Link
          href="/settings"
          className="min-h-11 content-center rounded-md px-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
        >
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
  if (image) {
    return (
      // A Google avatar URL. next/image would need the Google host in the
      // config, and the image is small.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt={`Signed in as ${name}`}
        title={`Signed in as ${name}`}
        width={32}
        height={32}
        referrerPolicy="no-referrer"
        className="size-8 rounded-full bg-accent-soft"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={`Signed in as ${name}`}
      title={`Signed in as ${name}`}
      className="grid size-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
