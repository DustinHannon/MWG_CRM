"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { ensureBreakglass } from "@/lib/breakglass";
import { ValidationError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const inputSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(120),
  password: z.string().min(1, "Password is required").max(512),
  callbackUrl: z.string().optional(),
});

export async function signInBreakglassAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "auth.signin_breakglass" }, async () => {
    // Bootstrap if needed — also covered in authorize(), but here we get a
    // chance to print the password BEFORE the first failed attempt confuses
    // the user.
    await ensureBreakglass();

    const parsed = inputSchema.parse({
      username: formData.get("username"),
      password: formData.get("password"),
      callbackUrl: formData.get("callbackUrl") ?? undefined,
    });

    const { username, password, callbackUrl } = parsed;

    try {
      await signIn("breakglass", {
        username: username.toLowerCase(),
        password,
        redirectTo: safeCallback(callbackUrl),
      });
      // signIn throws NEXT_REDIRECT on success — withErrorBoundary's
      // isNextControlFlowError() guard re-throws it for the framework.
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.type === "CredentialsSignin") {
          throw new ValidationError("Invalid username or password.");
        }
        throw new ValidationError("Sign-in failed. Try again.");
      }
      throw err;
    }
  });
}

/**
 * Only allow same-origin relative paths. Prevents open-redirect attacks.
 */
function safeCallback(callback: string | undefined): string {
  if (!callback) return "/dashboard";
  if (!callback.startsWith("/") || callback.startsWith("//")) return "/dashboard";
  return callback;
}
