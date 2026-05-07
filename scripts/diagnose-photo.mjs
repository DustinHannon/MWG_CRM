// Diagnose why /me/photo isn't being cached for an Entra user.
// Reads the user's stored refresh_token, mints a fresh access_token,
// calls /me/photo/$value, prints status + content-type + first bytes.
//
// Usage: node scripts/diagnose-photo.mjs <userId>
import postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotenv(".env.local");
loadDotenv(".env");

const userId = process.argv[2];
if (!userId) {
  console.error("usage: node scripts/diagnose-photo.mjs <userId>");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER || "";
const tenantMatch = issuer.match(/login\.microsoftonline\.com\/([^\/]+)\//);
const tenantId = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID || (tenantMatch ? tenantMatch[1] : null);
const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const clientSecret = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

if (!dbUrl || !tenantId || !clientId || !clientSecret) {
  console.error("Missing env. Available:");
  console.error("  DB url:", dbUrl ? "yes" : "no");
  console.error("  tenant:", tenantId ? "yes" : "no");
  console.error("  clientId:", clientId ? "yes" : "no");
  console.error("  clientSecret:", clientSecret ? "yes" : "no");
  process.exit(1);
}

console.log("env check:");
console.log("  DATABASE_URL:", dbUrl ? "present" : "MISSING");
console.log("  TENANT_ID:", tenantId);
console.log("  CLIENT_ID:", clientId);
console.log("  CLIENT_SECRET:", clientSecret ? "present" : "MISSING");
console.log("  BLOB_READ_WRITE_TOKEN:", blobToken ? "present" : "MISSING");
console.log("");

const sql = postgres(dbUrl, { max: 1 });
const acct = await sql`
  SELECT "userId", refresh_token, access_token, expires_at, scope
  FROM accounts
  WHERE "userId" = ${userId} AND provider = 'microsoft-entra-id'
  LIMIT 1
`;
if (acct.length === 0) {
  console.error("No microsoft-entra-id account row for", userId);
  process.exit(1);
}

const refreshToken = acct[0].refresh_token;
console.log("Refreshing access token...");
const tokRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope: "openid profile email offline_access User.Read Mail.Read Mail.Send Mail.ReadWrite Calendars.Read Calendars.ReadWrite",
  }),
});
const tokBody = await tokRes.text();
console.log("Token refresh status:", tokRes.status);
if (!tokRes.ok) {
  console.error("Token refresh body:", tokBody.slice(0, 500));
  process.exit(1);
}
const tok = JSON.parse(tokBody);
const accessToken = tok.access_token;
console.log("  scopes returned:", tok.scope);
console.log("  expires in:", tok.expires_in, "seconds");
console.log("");

console.log("Calling GET /me/photo/$value ...");
const photoRes = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log("  status:", photoRes.status, photoRes.statusText);
console.log("  content-type:", photoRes.headers.get("content-type"));
console.log("  content-length:", photoRes.headers.get("content-length"));
if (!photoRes.ok) {
  const t = await photoRes.text();
  console.log("  body (first 500 chars):", t.slice(0, 500));
}

// Also try /me to confirm token works at all
console.log("");
console.log("Calling GET /me (sanity check) ...");
const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log("  status:", meRes.status);
const meBody = await meRes.text();
console.log("  body:", meBody.slice(0, 300));

// Now try the full pipeline: fetch photo bytes + put to Vercel Blob.
console.log("");
console.log("Fetching photo bytes again for put() test ...");
const photoRes2 = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log("  status:", photoRes2.status);
if (!photoRes2.ok) {
  console.error("  Photo refetch failed:", photoRes2.status);
  await sql.end();
  process.exit(1);
}
const buf = await photoRes2.arrayBuffer();
console.log("  bytes:", buf.byteLength);

console.log("");
console.log("Putting to Vercel Blob (using @vercel/blob) ...");
try {
  const { put } = await import("@vercel/blob");
  const blob = await put(`users/${userId}/photo.jpg`, Buffer.from(buf), {
    access: "private",
    addRandomSuffix: false,
    contentType: photoRes2.headers.get("content-type") ?? "image/jpeg",
  });
  console.log("  put SUCCESS");
  console.log("  url:", blob.url);
  console.log("  pathname:", blob.pathname);

  console.log("");
  console.log("Updating DB row ...");
  await sql`
    UPDATE users
    SET photo_blob_url = ${blob.url}, photo_synced_at = now(), updated_at = now()
    WHERE id = ${userId}
  `;
  console.log("  DB update SUCCESS");
  console.log("");
  console.log("DONE. Refresh the app — your avatar should now render.");
} catch (err) {
  console.error("  Blob put or DB update FAILED:");
  console.error("  name:", err.name);
  console.error("  message:", err.message);
  console.error("  stack:", err.stack);
}

await sql.end();
