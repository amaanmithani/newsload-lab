import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["proxy/**/*.ts", "lib/**/*.ts", "app/api/**/*.ts"],
      exclude: ["proxy/main.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
