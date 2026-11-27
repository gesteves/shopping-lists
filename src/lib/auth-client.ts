import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// oauthProviderClient adds the signed OAuth query of the page (#18) to the
// sign-in and consent requests, thus the authorization continues after them.
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});
