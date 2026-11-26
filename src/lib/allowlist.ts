/** Read `ALLOWED_EMAILS` (comma-separated) into a set of lowercase emails. */
export function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True only if the email is in `ALLOWED_EMAILS`. An empty list allows no one. */
export function isAllowedEmail(
  email: string | null | undefined,
  allowlist: string | undefined,
): boolean {
  if (!email) return false;
  return parseAllowlist(allowlist).has(email.trim().toLowerCase());
}
