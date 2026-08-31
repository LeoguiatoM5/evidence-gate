import { describe, expect, it } from "vitest";
import { analyzeGitDiff } from "./index.js";

const sampleDiff = `diff --git a/src/payment/checkout.ts b/src/payment/checkout.ts
index 1111111..2222222 100644
--- a/src/payment/checkout.ts
+++ b/src/payment/checkout.ts
@@ -1,2 +1,3 @@
-const limit = 10;
+const limit = 20;
+const enabled = true;
 export { limit };
diff --git a/src/orders/legacy.ts b/src/orders/legacy.ts
deleted file mode 100644
--- a/src/orders/legacy.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const legacy = true;
`;

describe("analyzeGitDiff", () => {
  it("extracts changes, line counts, areas and configured criticality", () => {
    const result = analyzeGitDiff(sampleDiff, [
      { pathPrefix: "src/payment/", area: "Payments", businessCriticality: 95 }
    ]);

    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(2);
    expect(result.affectedAreas).toEqual(["Payments", "orders"]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        path: "src/payment/checkout.ts",
        type: "MODIFIED",
        additions: 2,
        deletions: 1,
        area: "Payments",
        businessCriticality: 95
      }),
      expect.objectContaining({
        path: "src/orders/legacy.ts",
        type: "DELETED",
        additions: 0,
        deletions: 1,
        area: "orders"
      })
    ]);
  });

  it("refuses input without supported Git changes", () => {
    expect(() => analyzeGitDiff("not a git diff")).toThrow(/does not contain/i);
  });
});
