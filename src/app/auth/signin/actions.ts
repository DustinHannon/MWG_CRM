"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { ensureBreakglass } from "@/lib/breakglass";
import { logger } from "@/lib/logger";

const inputSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(120),
  password: z.string().min(1, "Password is required").max(512),
  callbackUrl: z.string().optional(),
});

export type SignInResult =
  | { ok: true }
  | { ok: false; error: string };

export async function signInBreakglassAction(
  formData: FormData,
): Promise<SignInResult> {
  // Bootstrap if needed — also covered in authorize(), but here we get a
  // chance to print the password BEFORE the first failed attempt confuses
  // the user.
  await ensureBreakglass();

  const parsed = inputSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    callbackUrl: formData.get("callbackUrl") ?? undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { username, password, callbackUrl } = parsed.data;

  try {
    await signIn("breakglass", {
      username: username.toLowerCase(),
      password,
      redirectTo: safeCallback(callbackUrl),
    });
    return { ok: true };
  } catch (err) {
    // Auth.js throws a special redirect error on success — re-throw so the
    // framework can complete the redirect.
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw err;
    }

    if (err instanceof AuthError) {
      if (err.type === "CredentialsSignin") {
        return { ok: false, error: "Invalid username or password." };
      }
      return { ok: false, error: "Sign-in failed. Try again." };
    }

    logger.error("signin.breakglass_unexpected_error", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Sign-in failed. Try again." };
  }
}

/**
 * Only allow same-origin relative paths. Prevents open-redirect attacks.
 */
function safeCallback(callback: string | undefined): string {
  if (!callback) return "/dashboard";
  if (!callback.startsWith("/") || callback.startsWith("//")) return "/dashboard";
  return callback;
}
