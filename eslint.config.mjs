import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "drizzle/**",
    ".vercel/**",
    ".playwright-mcp/**",
    "next-env.d.ts",
  ]),
]);
