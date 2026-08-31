import { defineConfig } from "vitest/config";

/**
 * Vitest configuration used only by the mutation run. Mutation testing executes the
 * suite once per mutant, so it points at the pure domain engines, whose tests run in
 * milliseconds. The integration suites, which spawn processes and open databases,
 * would make a mutation run take hours.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/quality-engine/src/**/*.test.ts", "packages/risk-engine/src/**/*.test.ts"]
  }
});
