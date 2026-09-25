import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = process.argv[2];
const outputDirectory = resolve(process.argv[3] ?? ".release");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

function fail(message) {
  console.error(`Release preparation failed: ${message}`);
  process.exit(1);
}

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag ?? "")) {
  fail("tag must have the form vX.Y.Z");
}
if (tag !== `v${manifest.version}`) {
  fail(`tag ${tag} does not match package.json version ${manifest.version}`);
}

mkdirSync(outputDirectory, { recursive: true });
const packed = spawnSync(
  "npm",
  ["pack", "--json", "--pack-destination", outputDirectory],
  {
    encoding: "utf8",
  },
);
if (packed.status !== 0) {
  fail(packed.stderr.trim() || "npm pack failed");
}

let result;
try {
  [result] = JSON.parse(packed.stdout);
} catch {
  fail("npm pack did not return JSON");
}
const topLevel = [
  ...new Set(result.files.map(({ path }) => path.split("/")[0])),
].sort();
const expected = ["LICENSE", "README.md", "index.ts", "package.json", "src"];
if (JSON.stringify(topLevel) !== JSON.stringify(expected)) {
  fail(`unexpected tarball contents: ${topLevel.join(", ")}`);
}

console.log(
  `Prepared ${result.filename} for ${manifest.name}@${manifest.version}`,
);
