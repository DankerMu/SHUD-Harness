import { expect, test } from "vitest";
import { containsPath } from "./index.ts";

test.each([
  ["/", "/workspace/input", true],
  ["/input", "/input", true],
  ["/input", "/input/run", true],
  ["/input/", "/input/run", true],
  ["/input", "/inputs/run", false],
  ["/input", "/elsewhere/input", false],
])("canonical containment %s → %s is %s", (root, target, expected) => {
  expect(containsPath(root, target)).toBe(expected);
});
