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
    // Playwright + test runtime artifacts. All gitignored and
    // regenerated every run; the HTML report ships minified
    // third-party trace-viewer bundles that trip react-hooks rules
    // (false positives on vendor code that never runs in the app).
    "playwright-report/**",
    "playwright/.cache/**",
    "test-results/**",
    ".playwright-review/**",
    "next-env.d.ts",
  ]),
]);
