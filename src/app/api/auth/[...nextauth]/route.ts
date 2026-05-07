// Auth.js v5 catchall route. The handlers come from src/auth.ts so that
// server components (which import auth() directly) and the HTTP edge share
// a single config.
export { GET, POST } from "@/auth-handlers";
