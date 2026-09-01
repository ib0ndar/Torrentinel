import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;

const checks = [
  ["package-lock.json root version", packageLock.version, version],
  ["package-lock.json package version", packageLock.packages?.[""]?.version, version],
];

const textChecks = [
  ["compose.yaml image", "../compose.yaml", new RegExp(`image: bah0/torrentinel:${tag.replaceAll(".", "\\.")}\\b`)],
  ["Podman Quadlet image", "../deploy/torrentinel.container", new RegExp(`Image=docker\\.io/bah0/torrentinel:${tag.replaceAll(".", "\\.")}\\b`)],
  ["changelog heading", "../CHANGELOG.md", new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m")],
  ["changelog release link", "../CHANGELOG.md", new RegExp(`^\\[${version.replaceAll(".", "\\.")}\\]: .*/${tag.replaceAll(".", "\\.")}$`, "m")],
];

for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    throw new Error(`${name} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
  }
}

for (const [name, path, pattern] of textChecks) {
  const content = readFileSync(new URL(path, import.meta.url), "utf8");
  if (!pattern.test(content)) throw new Error(`${name} does not match ${tag}`);
}

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pinnedReleases = [...readme.matchAll(/^RELEASE=(v\d+\.\d+\.\d+)$/gm)].map((match) => match[1]);
if (pinnedReleases.length === 0) throw new Error("README.md contains no pinned RELEASE examples");
for (const pinnedRelease of pinnedReleases) {
  if (pinnedRelease !== tag) throw new Error(`README.md pins ${pinnedRelease}; expected ${tag}`);
}

console.log(`Release metadata is consistent for ${tag}`);
