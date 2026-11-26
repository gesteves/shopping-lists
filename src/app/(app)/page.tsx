import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { signOut } from "../actions";

// Placeholder. Ticket #8 replaces this page.
export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-6 py-10">
      <h1 className="text-4xl font-semibold tracking-tight text-green-900">
        Shopping Lists
      </h1>
      <Suspense fallback={<p className="mt-4 text-stone-500">Loading…</p>}>
        <Account />
      </Suspense>
    </main>
  );
}

async function Account() {
  const user = await requireUser();
  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      <p className="text-stone-700">Signed in as {user.name}</p>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-md px-3 py-2 text-sm font-medium text-green-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-800"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
