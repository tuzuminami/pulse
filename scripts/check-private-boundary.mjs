import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const publicExactPaths = new Set([
  ".gitignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json"
]);

const publicDirectoryPrefixes = [
  ".github/",
  "examples/",
  "openapi/",
  "scripts/",
  "src/",
  "tests/"
];

const prohibitedPathPatterns = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)(\.private|\.codex-private|private-ai-control-plane)(\/|$)/,
  /(^|\/)(\.local-data|evidence-private|private-fixtures)(\/|$)/,
  /\.env$/,
  /\.private\.(md|json|ya?ml)$/
];

const prohibitedContentPatterns = [
  /(?:PRIVATE|CONFIDENTIAL)_(?:OPERATOR|SPECIFICATION|CONTROL|REQUIREMENTS?|MATERIAL)/,
  /DO_NOT_(?:COMMIT|PUBLISH)/,
  /INTERNAL_RELEASE_FIXTURE/
];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function listGitFiles(args) {
  const output = git(args);
  return output.length === 0 ? [] : output.split("\n");
}

function fail(message) {
  console.error(`private-boundary: ${message}`);
  process.exit(1);
}

const trackedFiles = listGitFiles(["ls-files"]);
const stagedChangedFiles = listGitFiles(["diff", "--cached", "--name-status"])
  .filter((line) => !line.startsWith("D\t"))
  .map((line) => line.slice(2));
const untrackedFiles = listGitFiles(["ls-files", "--others", "--exclude-standard"]);

const files = new Set([...trackedFiles, ...stagedChangedFiles, ...untrackedFiles]);

for (const file of files) {
  if (!isPublicReleasePath(file)) {
    fail(`path is not allowlisted for the public release tree: ${file}`);
  }
  if (prohibitedPathPatterns.some((pattern) => pattern.test(file))) {
    fail(`prohibited path is tracked or staged: ${file}`);
  }
}

for (const file of files) {
  if (file.endsWith(".md") || file.endsWith(".json") || file.endsWith(".yaml") || file.endsWith(".yml")) {
    const content = readContentForScan(file);
    if (content !== undefined && prohibitedContentPatterns.some((pattern) => pattern.test(content))) {
      fail(`prohibited private marker found in: ${file}`);
    }
  }
}

for (const file of listFilesUnder("dist/src")) {
  const content = readFileSync(file, "utf8");
  if (prohibitedContentPatterns.some((pattern) => pattern.test(content))) {
    fail(`prohibited private marker found in generated artifact: ${file}`);
  }
}

console.log("private-boundary: passed");

function readContentForScan(file) {
  if (existsSync(file)) {
    return readFileSync(file, "utf8");
  }
  try {
    return execFileSync("git", ["show", `:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}

function isPublicReleasePath(file) {
  return publicExactPaths.has(file) || publicDirectoryPrefixes.some((prefix) => file.startsWith(prefix));
}

function listFilesUnder(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { recursive: true })
    .map((entry) => join(directory, entry))
    .filter((entry) => existsSync(entry) && statSync(entry).isFile());
}
