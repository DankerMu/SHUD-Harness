import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  version?: unknown;
};
if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("The canonical root package.json must contain a nonempty version string");
}

const output = new URL("packages/dsh-shud-records/lib/", root);
mkdirSync(output, { recursive: true });
writeFileSync(
  new URL("harness-version.json", output),
  `${JSON.stringify({ version: manifest.version }, null, 2)}\n`,
);
