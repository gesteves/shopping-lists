import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { EMAIL_NOT_ALLOWED } from "@/lib/auth-errors";
import { getCurrentUser } from "@/lib/session";
import { GoogleSignInButton } from "./google-sign-in-button";

export const metadata: Metadata = { title: "Sign in – Shopping Lists" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <h1 className="text-5xl leading-[0.95] font-semibold tracking-tight text-balance text-accent">
        Shopping Lists
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        Sign in to see the lists you share.
      </p>
      <Suspense>
        <RedirectIfSignedIn searchParams={searchParams} />
        <SignInError searchParams={searchParams} />
      </Suspense>
      <GoogleSignInButton />
    </main>
  );
}

async function RedirectIfSignedIn({
  searchParams,
}: Pick<PageProps<"/sign-in">, "searchParams">) {
  // An OAuth request (#18) can ask for a new sign-in (prompt=login). Then
  // the page has the signed query, and must not go to the app.
  const { sig } = await searchParams;
  if (!sig && (await getCurrentUser())) redirect("/");
  return null;
}

async function SignInError({
  searchParams,
}: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { error } = await searchParams;
  if (!error) return null;
  const message =
    error === EMAIL_NOT_ALLOWED
      ? "This Google account can’t use Shopping Lists. Sign in with the account you use for the lists."
      : "Sign-in didn’t finish. Try again.";
  return (
    <p
      role="alert"
      className="mt-6 border-l-4 border-danger py-1 pl-3 text-danger"
    >
      {message}
    </p>
  );
}
