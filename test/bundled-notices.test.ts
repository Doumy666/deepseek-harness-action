import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const directories: string[] = [];
const publishedLicense =
  "Copyright 2026 Example. Permission is hereby granted to use this fixture. THE SOFTWARE IS PROVIDED AS IS.";
const packageIntegrity = "sha512-Zml4dHVyZQ==";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function write(root: string, path: string, value: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, value);
}

async function fixture(
  options: { licenseFile?: boolean; readmeLicense?: boolean; supplemental?: unknown } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-notices-"));
  directories.push(root);
  await mkdir(join(root, "scripts"));
  await copyFile(
    join(projectRoot, "scripts/generate-bundled-notices.mjs"),
    join(root, "scripts/generate-bundled-notices.mjs"),
  );
  await write(
    root,
    "package-lock.json",
    JSON.stringify({
      packages: { "node_modules/example": { version: "1.0.0", integrity: packageIntegrity } },
    }),
  );
  await write(
    root,
    "node_modules/example/package.json",
    JSON.stringify({
      name: "example",
      version: "1.0.0",
      license: "MIT",
      repository: "https://example.test/source",
    }),
  );
  await write(
    root,
    "dist/index.js.map",
    JSON.stringify({ sources: ["webpack://project/node_modules/example/index.js"] }),
  );
  if (options.licenseFile) await write(root, "node_modules/example/LICENSE", publishedLicense);
  if (options.readmeLicense)
    await write(
      root,
      "node_modules/example/README.md",
      `# Example\n\n## License\n\n${publishedLicense}\n`,
    );
  await write(
    root,
    "assets/licenses/supplemental-notices.json",
    JSON.stringify(options.supplemental ?? {}),
  );
  return root;
}

function supplemental(overrides: Record<string, unknown> = {}) {
  return {
    "example@1.0.0": {
      packageIntegrity,
      license: "MIT",
      kind: "license-text",
      source: "https://example.test/immutable-commit/LICENSE",
      text: publishedLicense,
      textSha256: createHash("sha256").update(publishedLicense).digest("hex"),
      ...overrides,
    },
  };
}

function run(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/generate-bundled-notices.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

describe("bundled dependency notice CLI", () => {
  it("checks drift without rewriting and accepts its deterministic generated output", async () => {
    const root = await fixture({ licenseFile: true });
    await write(root, "BUNDLED_DEPENDENCIES.md", "old reviewed notices\n");
    const stale = run(root, "--check");
    expect(stale.status).toBe(1);
    expect(await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8")).toBe(
      "old reviewed notices\n",
    );
    expect(run(root).status).toBe(0);
    const generated = await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8");
    expect(generated).toContain("## example@1.0.0");
    expect(generated).toContain(publishedLicense);
    expect(run(root, "--check").status).toBe(0);
    expect(run(root).status).toBe(0);
    expect(await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8")).toBe(generated);
  });

  it("reads an actual README grant rather than treating a missing LICENSE filename as missing permission text", async () => {
    const root = await fixture({ readmeLicense: true });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8")).toContain(
      publishedLicense,
    );
  });

  it("uses only version-bound, integrity-bound and checksum-verified offline supplemental text", async () => {
    const root = await fixture({ supplemental: supplemental() });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    const output = await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8");
    expect(output).toContain(publishedLicense);
    expect(output).toContain("https://example.test/immutable-commit/LICENSE");
    expect(run(root, "--check").status).toBe(0);
  });

  it.each([
    { source: "" },
    { textSha256: "0".repeat(64) },
    { packageIntegrity: "sha512-another-package" },
    { kind: "ignore" },
  ])("rejects an invalid supplemental record: %j", async (invalid) => {
    const root = await fixture({ supplemental: supplemental(invalid) });
    await write(root, "BUNDLED_DEPENDENCIES.md", "preserve prior notices\n");
    expect(run(root).status).toBe(1);
    expect(await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8")).toBe(
      "preserve prior notices\n",
    );
  });

  it("labels a declaration-only source instead of inventing a full license grant", async () => {
    const root = await fixture({
      supplemental: supplemental({
        kind: "declaration",
        text: "MIT",
        textSha256: createHash("sha256").update("MIT").digest("hex"),
      }),
    });
    expect(run(root).status).toBe(0);
    const output = await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8");
    expect(output).toContain("declaration only");
    expect(output).not.toContain("Permission is hereby granted");
  });

  it("covers sources from every NCC map while deduplicating the same package version", async () => {
    const root = await fixture({ licenseFile: true });
    await write(
      root,
      "dist/chunk.js.map",
      JSON.stringify({
        sources: [
          "webpack://project/node_modules/example/other.js",
          "webpack://project/node_modules/other/index.js",
        ],
      }),
    );
    await write(
      root,
      "node_modules/other/package.json",
      JSON.stringify({ name: "other", version: "2.0.0", license: "MIT" }),
    );
    await write(root, "node_modules/other/LICENSE", "Other independent license text");
    await write(
      root,
      "package-lock.json",
      JSON.stringify({
        packages: {
          "node_modules/example": { version: "1.0.0", integrity: packageIntegrity },
          "node_modules/other": { version: "2.0.0" },
        },
      }),
    );
    expect(run(root).status).toBe(0);
    const output = await readFile(join(root, "BUNDLED_DEPENDENCIES.md"), "utf8");
    expect(output.match(/## example@1\.0\.0/gu)).toHaveLength(1);
    expect(output).toContain("## other@2.0.0");
  });

  it("fails for an unaccounted package and obsolete supplemental data", async () => {
    const missing = await fixture();
    expect(run(missing).status).toBe(1);
    const obsolete = await fixture({ licenseFile: true, supplemental: supplemental() });
    expect(run(obsolete).status).toBe(1);
    const wrongVersion = await fixture({
      supplemental: { "example@0.9.0": supplemental()["example@1.0.0"] },
    });
    expect(run(wrongVersion).status).toBe(1);
  });
});
