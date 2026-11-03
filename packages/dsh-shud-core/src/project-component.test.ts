import { expect, test } from "vitest";
import { isProjectComponent } from "./index.ts";

test.each([
  ["", false],
  [".", false],
  ["..", false],
  ["/", false],
  ["a/b", false],
  ["\\", false],
  ["a\\b", false],
  ["\0", false],
  ["a\0b", false],
  ["tiny", true],
  ["a..b", true],
  ["...", true],
  [" ", true],
  ["a b", true],
  ["\n", true],
  ["雨", true],
  ["𐀀", true],
  ["tiny; touch CANARY", true],
  ["a:b", true],
  [".hidden", true],
  ["a.", true],
])("project component %j is %s", (project, expected) => {
  expect(isProjectComponent(project)).toBe(expected);
});
