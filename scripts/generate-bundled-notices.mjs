import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
  throw new Error("Usage: node scripts/generate-bundled-notices.mjs [--check]");
}
const check = arguments_.includes("--check");
function normalizeText(value) {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+$/gmu, "")
    .trim();
}

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function packageLicense(directory) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    const text = await optionalText(join(directory, name));
    if (text?.trim()) return normalizeText(text);
  }
  for (const name of ["README.md", "README.markdown", "README"]) {
    const text = await optionalText(join(directory, name));
    const section = text?.match(/^#{1,6}\s+licen[cs]e[^\n]*\n([\s\S]*)$/imu)?.[1];
    // A bare SPDX label is not a permission grant. Only the actual published
    // MIT text is present in the current README-only bundled package.
    if (section?.includes("Permission is hereby granted") && section.includes("THE SOFTWARE")) {
      return normalizeText(
        section.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
      );
    }
  }
  return undefined;
}
const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
const supplemental = JSON.parse(
  await readFile(join(projectRoot, "assets/licenses/supplemental-notices.json"), "utf8"),
);
const usedSupplemental = new Set();

function supplementalNotice(key, metadata) {
  const notice = supplemental[key];
  if (notice === undefined) throw new Error(`No license text or reviewed declaration for ${key}`);
  if (
    typeof notice.packageIntegrity !== "string" ||
    notice.packageIntegrity !== metadata.integrity ||
    typeof notice.license !== "string" ||
    notice.license.trim() === "" ||
    !["license-text", "declaration"].includes(notice.kind) ||
    typeof notice.source !== "string" ||
    !notice.source.startsWith("https://") ||
    new URL(notice.source).hostname === "" ||
    typeof notice.text !== "string" ||
    notice.text.trim() === "" ||
    createHash("sha256").update(notice.text).digest("hex") !== notice.textSha256
  ) {
    throw new Error(`Supplemental notice identity, source or checksum mismatch for ${key}`);
  }
  usedSupplemental.add(key);
  return notice;
}
const distDirectory = join(projectRoot, "dist");
const sourceMaps = (await readdir(distDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js.map"))
  .map((entry) => entry.name)
  .sort();

if (sourceMaps.length === 0) {
  throw new Error("No NCC source maps found in dist; run npm run build first");
}

function packagePathFromSource(source) {
  const segments = source.replaceAll("\\", "/").split("/");
  const firstNodeModules = segments.indexOf("node_modules");
  const lastNodeModules = segments.lastIndexOf("node_modules");
  if (firstNodeModules === -1) return undefined;

  const packageNameStart = lastNodeModules + 1;
  const packageNameLength = segments[packageNameStart]?.startsWith("@") ? 2 : 1;
  const packageNameEnd = packageNameStart + packageNameLength;
  if (
    packageNameEnd > segments.length ||
    segments.slice(packageNameStart, packageNameEnd).some((part) => part === "")
  ) {
    throw new Error(`Cannot identify bundled package from source map entry: ${source}`);
  }
  return segments.slice(firstNodeModules, packageNameEnd).join("/");
}

const bundledPackagePaths = new Set();
for (const sourceMap of sourceMaps) {
  const parsed = JSON.parse(await readFile(join(distDirectory, sourceMap), "utf8"));
  if (!Array.isArray(parsed.sources)) {
    throw new Error(`${sourceMap} has no sources array`);
  }
  for (const source of parsed.sources) {
    if (typeof source !== "string") {
      throw new Error(`${sourceMap} contains a non-string source entry`);
    }
    const packagePath = packagePathFromSource(source);
    if (packagePath !== undefined) bundledPackagePaths.add(packagePath);
  }
}

const byPackage = new Map();

for (const packagePath of bundledPackagePaths) {
  const metadata = lock.packages?.[packagePath];
  if (metadata === undefined) {
    throw new Error(`Bundled package is absent from package-lock.json: ${packagePath}`);
  }
  const manifestPath = join(projectRoot, packagePath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (metadata.version !== manifest.version) {
    throw new Error(
      `Bundled package lock mismatch for ${manifest.name}: ${metadata.version ?? "unknown"} != ${manifest.version}`,
    );
  }
  const directory = dirname(manifestPath);
  const key = `${manifest.name}@${manifest.version}`;
  const packagedLicense = await packageLicense(directory);
  const reviewed = packagedLicense === undefined ? supplementalNotice(key, metadata) : undefined;
  const entry = {
    name: manifest.name,
    version: manifest.version,
    repository:
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? manifest.homepage ?? ""),
    license: reviewed?.license ?? manifest.license ?? "See reproduced license text",
    licenseText: normalizeText(packagedLicense ?? reviewed.text),
    noticeSource: reviewed?.source,
    declarationOnly: reviewed?.kind === "declaration",
  };
  const previous = byPackage.get(key);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(entry)) {
    throw new Error(`Conflicting notices for bundled copies of ${key}`);
  }
  byPackage.set(key, entry);
}

for (const key of Object.keys(supplemental)) {
  if (!usedSupplemental.has(key))
    throw new Error(`Unused supplemental notice must be removed: ${key}`);
}
const entries = [...byPackage.values()];
entries.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);

const output = [
  "# Bundled dependency notices",
  "",
  "The Marketplace `dist/` bundle statically includes the dependency modules",
  "reported by the committed NCC source maps. The corresponding notices follow.",
  "",
  "The DSH worker runtime is installed from `package-lock.json` in the",
  "Controller-created Docker runtime. Controller imports of DSH boot helpers",
  "and their dependencies are listed below whenever the NCC source maps include",
  "them; separate worker-only packages are not part of these static notices.",
  "",
  ...entries.flatMap((entry) => [
    `## ${entry.name}@${entry.version}`,
    "",
    `License: ${entry.license}`,
    ...(entry.repository === "" ? [] : [`Source: ${entry.repository}`]),
    ...(entry.noticeSource === undefined ? [] : [`Notice source: ${entry.noticeSource}`]),
    ...(entry.declarationOnly
      ? ["Published license declaration only; the package does not include a full license grant."]
      : []),
    "",
    "```text",
    entry.licenseText.replaceAll("```", "` ` `"),
    "```",
    "",
  ]),
].join("\n");

const outputPath = join(projectRoot, "BUNDLED_DEPENDENCIES.md");
if (check) {
  const existing = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing !== output) {
    throw new Error(
      "Bundled dependency notices have drifted; run npm run generate:bundled-notices",
    );
  }
} else {
  await writeFile(outputPath, output, "utf8");
}
console.log(
  `Bundled notices ${check ? "verified" : "generated"}: ${String(bundledPackagePaths.size)} package paths, ${String(entries.length)} distinct package versions`,
);
