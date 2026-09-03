import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const isPrerelease = version.includes("-");
const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const checks = [
  ["package-lock.json root version", packageLock.version, version],
  ["package-lock.json package version", packageLock.packages?.[""]?.version, version],
];

const textChecks = [
  ["compose.yaml image", "../compose.yaml", new RegExp(isPrerelease
    ? `image: ["']?bah0/torrentinel:${escapedTag}["']?$`
    : `image: bah0/torrentinel:${escapedTag}\\b`, "m")],
  ["Podman Quadlet image", isPrerelease
    ? "../deploy/torrentinel-integrated.container"
    : "../deploy/torrentinel.container", new RegExp(isPrerelease
    ? `Image=docker\\.io/bah0/torrentinel:${escapedTag}$`
    : `Image=docker\\.io/bah0/torrentinel:${escapedTag}\\b`, "m")],
  ["changelog heading", "../CHANGELOG.md", new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m")],
  ...isPrerelease ? [] : [[
    "changelog release link",
    "../CHANGELOG.md",
    new RegExp(`^\\[${version.replaceAll(".", "\\.")}\\]: .*/${escapedTag}$`, "m"),
  ]],
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
const hardcodedReadmeReleases = [...readme.matchAll(/^RELEASE=["']?v\d+\.\d+\.\d+["']?$/gm)].map((match) => match[0]);
if (hardcodedReadmeReleases.length > 0) {
  throw new Error(`README.md contains hardcoded release assignments: ${hardcodedReadmeReleases.join(", ")}`);
}

if (isPrerelease) {
  if (!readme.includes("--branch torrentinel_integrated")) {
    throw new Error("README.md prerelease examples must check out torrentinel_integrated");
  }
} else {
  const latestReleaseUrl = "https://github.com/ib0ndar/Torrentinel/releases/latest";
  const releaseResolver = 'RELEASE="${release_url##*/}"';
  const latestReleaseSnippet = `release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' \\
  ${latestReleaseUrl})"
${releaseResolver}`;
  const resolverCount = readme.split(releaseResolver).length - 1;
  const completeSnippetCount = readme.split(latestReleaseSnippet).length - 1;
  if (resolverCount === 0 || completeSnippetCount !== resolverCount) {
    throw new Error("README.md latest-release examples must pair the GitHub latest URL with the shell release resolver");
  }
}

console.log(isPrerelease
  ? `Prerelease metadata is consistent for ${tag}; README examples use torrentinel_integrated`
  : `Release metadata is consistent for ${tag}; README installation examples resolve the latest stable release dynamically`);
