import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // k6 scripts run in k6's goja runtime (ES modules, k6/* imports, __ENV globals).
    files: ["load/**/*.js"],
    languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } },
    rules: { "import/no-anonymous-default-export": "off" },
  },
  globalIgnores([".next/**", "node_modules/**", "coverage/**", "results/**", "next-env.d.ts"]),
]);
