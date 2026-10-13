import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { runInstaller } from "../packages/create-deepseek-harness-action/src/installer.mjs";
import { runProcess } from "../packages/create-deepseek-harness-action/src/process.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("fixtures/installer-process-tool.mjs", import.meta.url));
let suite = "";
let templates = "";
class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  suite = await mkdtemp(join(tmpdir(), "dsh-installer-process-"));
  const built = join(suite, "dist");
  await exec(
    process.execPath,
    ["packages/create-deepseek-harness-action/scripts/build.mjs", "--output", built],
    {
      env: { ...process.env, DSH_ACTION_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567" },
      windowsHide: true,
    },
  );
  templates = join(built, "templates");
});

afterAll(async () => {
  if (suite) await rm(suite, { recursive: true, force: true });
});

describe("public installer external process lifecycle", () => {
  it.each(["checkout", "worktree"])(
    "binds genuine PATH tools to absolute executables and ignores text shadows in a %s",
    async (kind) => {
      const base = await mkdtemp(join(suite, "trusted-tools-"));
      await exec("git", ["init", "-b", "main", base]);
      await exec("git", ["remote", "add", "origin", "https://github.com/example/sample.git"], {
        cwd: base,
      });
      let root = base;
      if (kind === "worktree") {
        await exec(
          "git",
          [
            "-c",
            "user.name=Installer Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            `core.hooksPath=${suite}`,
            "commit",
            "--allow-empty",
            "-m",
            "Fixture",
          ],
          { cwd: base },
        );
        root = join(base, "linked-checkout");
        await exec("git", ["worktree", "add", "-b", "fixture-worktree", root], { cwd: base });
      }
      const nested = join(root, "nested");
      await mkdir(nested);
      for (const name of ["git.exe", "gh.exe", "node.exe", "taskkill.exe", "git", "gh", "node"])
        await writeFile(
          join(root, name),
          "Non-executable text placeholder. Must never be selected.\n",
        );
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const path = [
        root,
        "",
        "relative-tool-directory",
        dirname(process.execPath),
        process.env[pathKey] ?? "",
      ].join(delimiter);
      const hostEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
      );
      const environment = {
        ...hostEnvironment,
        [process.platform === "win32" ? "Path" : "PATH"]: path,
      };
      const observations: { executable: string; cwd: string }[] = [];
      const result = await runInstaller({
        argv: [],
        cwd: nested,
        input: Readable.from([]),
        output: new Capture(),
        isTTY: true,
        env: {},
        templateDirectory: templates,
        prompter: {
          question: (message) => Promise.resolve(message.startsWith("Create") ? "y" : "n"),
          secret: () => Promise.reject(new Error("No logged-in transport")),
          close: () => {
            /* The fixture owns no terminal handles. */
          },
        },
        processRunner: async (command, args, options) => {
          const processOptions = { ...options, env: environment };
          if (command !== "gh") return runProcess(command, args, processOptions);
          const result = await runProcess(
            "node",
            [
              "-e",
              "process.stdout.write(JSON.stringify({executable:process.argv0,cwd:process.cwd()}));process.exit(process.argv[1]==='auth'?1:0)",
              "--",
              args[0] ?? "",
            ],
            processOptions,
          );
          observations.push(
            z.object({ executable: z.string(), cwd: z.string() }).parse(JSON.parse(result.stdout)),
          );
          return result;
        },
      });
      expect(result.onboarding).toMatchObject({
        secret: "login_required",
        committed: false,
        pushed: false,
      });
      expect(observations).toHaveLength(2);
      expect(observations.every((entry) => isAbsolute(entry.executable))).toBe(true);
      expect(observations.every((entry) => !entry.executable.startsWith(root))).toBe(true);
      expect(observations.every((entry) => entry.cwd === root)).toBe(true);
    },
  );
  it("fails before file creation or Secret input when PATH contains only repo or relative entries", async () => {
    const root = await mkdtemp(join(suite, "no-trusted-tools-"));
    await exec("git", ["init", "-b", "main", root]);
    const output = new Capture();
    let prompted = false;
    await expect(
      runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        output,
        isTTY: true,
        env: {},
        templateDirectory: templates,
        prompter: {
          question: () => {
            prompted = true;
            return Promise.resolve("y");
          },
          secret: () => {
            prompted = true;
            return Promise.resolve("unsent-fixture-key");
          },
          close: () => {
            /* No terminal handles in the input adapter. */
          },
        },
        processRunner: (command, args, options) =>
          runProcess(command, args, {
            ...options,
            env: { PATH: [root, "", "relative-bin"].join(delimiter) },
          }),
      }),
    ).rejects.toThrow(/existing Git repository/u);
    expect(prompted).toBe(false);
    expect(output.text).toContain("absolute host PATH directory outside this repository");
    await expect(readFile(join(root, ".github/workflows/dsh-review.yml"))).rejects.toThrow();
  });
  it.each(process.platform === "win32" ? ["stall", "overflow"] : ["stall", "overflow", "orphan"])(
    "recovers from a real %s GitHub CLI process with pipe-holding descendants",
    async (mode) => {
      const root = await mkdtemp(join(suite, `${mode}-`));
      await exec("git", ["init", "-b", "main", root]);
      await exec("git", ["remote", "add", "origin", "https://github.com/example/sample.git"], {
        cwd: root,
      });
      await writeFile(
        join(root, "taskkill.exe"),
        "Non-executable text placeholder. System cleanup must ignore this file.\n",
      );
      const pidFile = join(root, "fixture-pids.json");
      const output = new Capture();
      let authFinished = false;
      const install = runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        output,
        isTTY: true,
        env: {},
        templateDirectory: templates,
        prompter: {
          question: (message) => Promise.resolve(message.startsWith("Create") ? "y" : "n"),
          secret: () =>
            Promise.reject(new Error("Secret input must not be requested without login")),
          close: () => {
            /* The input adapter owns no terminal handles. */
          },
        },
        processRunner: async (command, args, options) => {
          if (command !== "gh") return runProcess(command, args, options);
          const result = await runProcess(
            process.execPath,
            [fixture, args[0] === "--version" ? "version" : mode, pidFile],
            {
              ...options,
              timeoutMs: 500,
            },
          );
          if (args[0] === "auth") authFinished = true;
          return result;
        },
      });
      const deadline = AbortSignal.timeout(5000);
      try {
        const result = await Promise.race([
          install,
          delay(5000, undefined, { signal: deadline }).then(() => {
            throw new Error(
              "External process did not release inherited pipes within its bounded cleanup",
            );
          }),
        ]);
        expect(authFinished).toBe(true);
        expect(result.onboarding).toMatchObject({
          secret: "login_required",
          committed: false,
          pushed: false,
        });
        expect(output.text).toContain("gh auth login");
        const pids = z
          .array(z.number().int().positive())
          .parse(JSON.parse(await readFile(pidFile, "utf8")));
        for (let attempt = 0; attempt < 20 && pids.some(running); attempt += 1) await delay(50);
        expect(pids.filter(running)).toEqual([]);
        expect(await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
          'allow-write: "false"',
        );
      } finally {
        // A failing baseline must also dispose its deliberately hostile fixture.
        const pids = z
          .array(z.number().int().positive())
          .parse(JSON.parse(await readFile(pidFile, "utf8")));
        for (const pid of pids.reverse()) {
          if (running(pid)) process.kill(pid, "SIGKILL");
        }
        await install.catch(() => {
          /* Fixture disposal must also settle the baseline's rejected setup. */
        });
      }
    },
  );
});
