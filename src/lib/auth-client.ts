import { createAuthClient } from "better-auth/react";
import { adminClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [adminClient(), usernameClient()],
});

export const { signIn, signOut, useSession, getSession } = authClient;
