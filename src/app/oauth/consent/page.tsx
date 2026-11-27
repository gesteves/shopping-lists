import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { copy } from "@/copy";
import { getAuth } from "@/lib/auth";
import { SCOPES, displayHost, isLoopbackRedirect } from "@/lib/oauth";
import { requireUser } from "@/lib/session";
import { ConsentButtons } from "./consent-buttons";

export const metadata: Metadata = {
  title: copy.app.pageTitle(copy.consent.title),
};

// The consent page of the OAuth server (#18). The authorize endpoint sends
// the user here with a signed copy of the request. The client name is a
// claim of the client (DCR or CIMD), thus the page also shows the hosts
// that the user can check: the client ID host and the redirect host.

export default function ConsentPage({
  searchParams,
}: PageProps<"/oauth/consent">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <Suspense>
        <Consent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** What a scope lets an app do. An unknown scope shows as it is. */
function scopeText(scope: string): string {
  const key = (Object.keys(SCOPES) as (keyof typeof SCOPES)[]).find(
    (k) => SCOPES[k] === scope,
  );
  return key ? copy.consent.scopes[key] : scope;
}

/** Only the signed parameters, as the provider signed them. */
function signedQuery(params: Record<string, string | string[] | undefined>) {
  const all = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value ?? ""]) {
      all.append(key, v);
    }
  }
  const names = new Set(["sig", "ba_param", ...all.getAll("ba_param")]);
  return new URLSearchParams([...all].filter(([key]) => names.has(key)));
}

async function Consent({
  searchParams,
}: Pick<PageProps<"/oauth/consent">, "searchParams">) {
  const user = await requireUser();
  const query = signedQuery(await searchParams);
  const auth = getAuth();
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(query.toString(), secret))) {
    return <Problem>{copy.consent.expired}</Problem>;
  }

  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const client = await auth.api
    .getOAuthClientPublic({
      query: { client_id: clientId },
      headers: await headers(),
    })
    .catch(() => null);
  if (!client) {
    return <Problem>{copy.consent.unknownApp}</Problem>;
  }

  const name = client.client_name?.trim() || copy.consent.unnamedApp;
  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);
  const clientHost = clientId.startsWith("https://")
    ? displayHost(clientId)
    : null;

  return (
    <>
      <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance">
        {copy.consent.heading(name)}
      </h1>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-muted">
        <dt>{copy.consent.appFrom}</dt>
        {clientHost ? (
          <dd className="font-medium break-all text-ink">{clientHost}</dd>
        ) : (
          // A DCR client: nothing proves where it comes from, or its name.
          <dd>
            <wa-badge variant="warning" appearance="filled">
              {copy.consent.unverified}
            </wa-badge>
          </dd>
        )}
        <dt>{copy.consent.sendsYouTo}</dt>
        <dd className="font-medium break-all text-ink">
          {displayHost(redirectUri)}
        </dd>
        <dt>{copy.consent.account}</dt>
        <dd className="font-medium break-all text-ink">{user.email}</dd>
      </dl>
      {isLoopbackRedirect(redirectUri) && (
        <wa-callout variant="warning" className="mt-6">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          {copy.consent.loopback}
        </wa-callout>
      )}
      <h2 className="mt-8 font-semibold">{copy.consent.canDo}</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-3">
            <wa-icon name="check" className="mt-1 text-accent"></wa-icon>
            <span>{scopeText(scope)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-ink-muted">{copy.consent.via(user.name)}</p>
      <ConsentButtons />
    </>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1 className="text-4xl font-semibold tracking-tight">
        {copy.consent.problem}
      </h1>
      <p role="alert" className="mt-4 text-lg text-ink-muted">
        {children}
      </p>
    </>
  );
}
