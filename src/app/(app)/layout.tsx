import { Suspense } from "react";
import { ServiceWorker } from "../service-worker";
import { SessionRefresh } from "../session-refresh";
import { AppHeader, HeaderFrame } from "./_components/app-header";
import { ListIndex } from "./_components/list-index";

// The signed-in shell. On a phone, one column: `/` is the lists, and
// `/lists/[id]` is one list. On a large screen, the lists are a sidebar
// beside the open list.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SessionRefresh />
      {/* usePathname() reads the request, thus it needs a boundary. */}
      <Suspense>
        <ServiceWorker />
      </Suspense>
      <Suspense fallback={<HeaderFrame />}>
        <AppHeader />
      </Suspense>
      <div className="flex flex-1 lg:grid lg:grid-cols-[22rem_1fr]">
        <aside
          aria-label="All lists"
          className="hidden border-r border-line px-4 py-6 lg:block"
        >
          <ListIndex headingLevel={2} />
        </aside>
        <main className="flex w-full flex-1 flex-col pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] lg:px-10">
          {children}
        </main>
      </div>
    </div>
  );
}
