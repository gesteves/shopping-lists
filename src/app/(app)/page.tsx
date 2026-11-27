import { Suspense } from "react";
import { copy } from "@/copy";
import { ListIndex } from "./_components/list-index";
import { RequireUser } from "./_components/require-user";

export default function HomePage() {
  return (
    <>
      <Suspense>
        <RequireUser />
      </Suspense>
      {/* On a large screen the sidebar has the lists. */}
      <div className="mx-auto w-full max-w-xl py-6 lg:hidden">
        <ListIndex />
      </div>
      <div className="hidden flex-1 place-items-center text-ink-muted lg:grid">
        <p className="text-lg">{copy.lists.pickOne}</p>
      </div>
    </>
  );
}
