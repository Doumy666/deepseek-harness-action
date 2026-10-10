import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInstaller } from "../packages/create-deepseek-harness-action/src/installer.mjs";
import type { ProcessResult } from "../packages/create-deepseek-harness-action/src/process.mjs";

const exec = promisify(execFile);
const releaseSha = "0123456789abcdef0123456789abcdef01234567";
let suite = "";
let templates = "";
class Capture extends Writable {
  text = "";
  onChunk?: (text: string) => void;
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.text += chunk.toString();
    this.onChunk?.(chunk.toString());
    done();
  }
}
class TerminalInput extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(raw: boolean) {
    this.raw = raw;
    return this;
  }
}
interface Call {
  command: string;
  args: readonly string[];
  cwd?: string;
  input?: string;
}
async function project() {
  const root = await mkdtemp(join(suite, "repo-"));
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["config", "user.name", "Installer Test"], { cwd: root });
  await exec("git", ["config", "user.email", "installer@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "Fixture"], { cwd: root });
  await exec("git", ["remote", "add", "origin", "https://github.com/example/sample.git"], {
    cwd: root,
  });
  return root;
}
function adapters(
  answers: string[],
  settings: {
    login?: boolean;
    secret?: string;
    failSecret?: boolean;
    remoteAhead?: boolean;
    localRemote?: string;
    uncertainCleanup?: boolean;
  } = {},
) {
  const output = new Capture();
  const calls: Call[] = [];
  const questions: string[] = [];
  const processRunner = async (
    command: string,
    args: readonly string[],
    options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<ProcessResult> => {
    calls.push({
      command,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (command === "gh") {
      if (args[0] === "--version") return { exitCode: 0, stdout: "gh version fixture", stderr: "" };
      if (args[0] === "auth")
        return {
          exitCode: settings.login === false ? 1 : 0,
          stdout: "",
          stderr: "",
          ...(settings.uncertainCleanup ? { termination: "unconfirmed" } : {}),
        };
      if (args[0] === "repo")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: "example/sample",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      if (args[0] === "secret" && args[1] === "list")
        return { exitCode: 0, stdout: "[]", stderr: "" };
      if (args[0] === "secret" && args[1] === "set")
        return {
          exitCode: settings.failSecret ? 1 : 0,
          stdout: settings.secret ?? "",
          stderr: settings.secret ?? "",
        };
      throw new Error("Unexpected gh operation");
    }
    if (args.includes("push") && settings.localRemote === undefined)
      return { exitCode: 0, stdout: "", stderr: "" };
    if (args.includes("ls-remote")) {
      const parent = await exec("git", ["rev-parse", "HEAD^"], { cwd: options.cwd });
      return {
        exitCode: 0,
        stdout: `${settings.remoteAhead ? "f".repeat(40) : parent.stdout.trim()}\trefs/heads/main\n`,
        stderr: "",
      };
    }
    const localRemote = settings.localRemote;
    const transportArgs =
      args.includes("push") && localRemote !== undefined
        ? args.map((argument) => (argument === "origin" ? localRemote : argument))
        : args;
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, [...transportArgs], {
        cwd: options.cwd,
        env:
          settings.localRemote === undefined
            ? options.env
            : { ...options.env, GIT_ALLOW_PROTOCOL: "file:https:ssh" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      child.stdin.end(options.input);
    });
  };
  const prompter = {
    question(message: string) {
      questions.push(message);
      return Promise.resolve(answers.shift() ?? "n");
    },
    secret() {
      return Promise.resolve(settings.secret ?? "secret-fixture-value");
    },
    close() {
      /* Input adapter has no terminal handles. */
    },
  };
  return { output, calls, questions, processRunner, prompter };
}
beforeAll(async () => {
  suite = await mkdtemp(join(tmpdir(), "dsh-guided-test-"));
  const built = join(suite, "dist");
  await exec(
    process.execPath,
    ["packages/create-deepseek-harness-action/scripts/build.mjs", "--output", built],
    { env: { ...process.env, DSH_ACTION_RELEASE_SHA: releaseSha }, windowsHide: true },
  );
  templates = join(built, "templates");
});
afterAll(async () => {
  if (suite) await rm(suite, { recursive: true, force: true });
});
describe("installer guided first run", () => {
  it("makes actual transport cleanup uncertainty recoverable without printing process output", async () => {
    const root = await project();
    const io = adapters(["y", "n"], { login: false, uncertainCleanup: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({
      secret: "login_required",
      committed: false,
      pushed: false,
    });
    expect(io.output.text).toContain("remaining Git/gh processes");
  });
  it("rejects multiple real Git push destinations before any remote publication", async () => {
    const root = await project();
    await exec(
      "git",
      ["config", "--add", "remote.origin.pushurl", "https://github.com/example/sample.git"],
      { cwd: root },
    );
    await exec(
      "git",
      ["config", "--add", "remote.origin.pushurl", "https://github.com/other/unconfirmed.git"],
      { cwd: root },
    );
    const io = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.some((call) => call.args.includes("push"))).toBe(false);
    expect(io.output.text).toContain("single verified");
  });

  it("publishes only its reviewed workflow commit even with real push.followTags enabled", async () => {
    const root = await project();
    const remote = join(suite, "follow-tags.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["push", remote, "HEAD:refs/heads/main"], { cwd: root });
    await exec("git", ["tag", "-a", "private-fixture-tag", "-m", "Must remain local"], {
      cwd: root,
    });
    await exec("git", ["config", "push.followTags", "true"], { cwd: root });
    const io = adapters(["y", "n", "y", "y"], { localRemote: remote });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    expect((await exec("git", ["ls-remote", "--tags", remote])).stdout).toBe("");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    expect((await exec("git", ["ls-remote", "--heads", remote, "main"])).stdout).toContain(head);
  });

  it("keeps explicit manual flags offline in a terminal without prompting for composition", async () => {
    const root = await mkdtemp(join(suite, "manual-project-"));
    const io = adapters([]);
    const result = await runInstaller({
      argv: ["--mode", "review"],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result).toEqual({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    expect(io.calls).toEqual([]);
    expect(io.questions).toEqual([]);
  });
  it("hides Secret echo using the real terminal prompt adapter and restores terminal mode", async () => {
    const root = await project();
    const key = "terminal-mask-fixture-key";
    const io = adapters([], { secret: key });
    const input = new TerminalInput();
    Object.defineProperty(io.output, "isTTY", { value: true });
    io.output.onChunk = (text) => {
      if (text.startsWith("Create a read-only") || text.startsWith("Set DEEPSEEK_API_KEY"))
        setImmediate(() => input.write("y\r"));
      if (text.startsWith("DeepSeek API key")) setImmediate(() => input.write(`${key}\r`));
      if (text.startsWith("Commit only")) setImmediate(() => input.write("n\r"));
    };
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input,
      output: io.output,
      processRunner: io.processRunner,
      isTTY: true,
      env: {},
      templateDirectory: templates,
    });
    expect(result.onboarding?.secret).toBe("configured");
    expect(io.output.text).not.toContain(key);
    expect(
      io.calls.find((call) => call.args[0] === "secret" && call.args[1] === "set")?.input,
    ).toBe(`${key}\n`);
    expect(input.raw).toBe(false);
    input.destroy();
  });
  it("retains a confirmed local commit when remote history differs and never force-pushes", async () => {
    const root = await project();
    const io = adapters(["y", "n", "y", "y"], { remoteAhead: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.some((call) => call.args.includes("push"))).toBe(false);
    expect(io.output.text).toContain("local commit is preserved");
  });
  it("preserves pre-existing staged changes and does not create an installer commit", async () => {
    const root = await project();
    await writeFile(join(root, "README.md"), "staged user change\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    const staged = (await exec("git", ["diff", "--cached"], { cwd: root })).stdout;
    const io = adapters(["y", "n", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.committed).toBe(false);
    expect((await exec("git", ["diff", "--cached"], { cwd: root })).stdout).toBe(staged);
    expect(
      io.calls.some((call) => call.args.includes("commit-tree") || call.args.includes("push")),
    ).toBe(false);
    expect(io.output.text).toContain("Existing staged changes were preserved");
  });
  it("keeps failed Secret setup recoverable without exposing even secret-bearing process errors", async () => {
    const root = await project();
    const key = "failed-transport-secret-fixture";
    const io = adapters(["y", "y", "n"], { secret: key, failSecret: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.secret).toBe("setup_failed");
    expect(io.output.text).toContain("failed or is uncertain");
    expect(io.output.text).not.toContain(key);
    expect(await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
      releaseSha,
    );
  });
  it("rejects a starter with write authority before creating a workflow or sending a Secret", async () => {
    const root = await project();
    const invalid = await mkdtemp(join(suite, "invalid-templates-"));
    const source = await readFile(join(templates, "dsh-review.yml"), "utf8");
    await writeFile(
      join(invalid, "dsh-review.yml"),
      source.replace('allow-write: "false"', 'allow-write: "true"'),
    );
    const io = adapters(["y", "y"]);
    await expect(
      runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        isTTY: true,
        env: {},
        templateDirectory: invalid,
        ...io,
      }),
    ).rejects.toThrow(/read-only PR Review configuration/u);
    await expect(readFile(join(root, ".github/workflows/dsh-review.yml"))).rejects.toThrow();
    expect(io.calls.some((call) => call.args[0] === "secret")).toBe(false);
  });
  it("resumes its existing workflow commit and offers push separately without creating a duplicate commit", async () => {
    const root = await project();
    const first = adapters(["y", "y", "y", "n"]);
    await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...first,
    });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const resumed = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...resumed,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(head);
    expect(resumed.calls.some((call) => call.args.includes("commit-tree"))).toBe(false);
  });
  it("pushes only the new workflow commit after a separate confirmation and parent binding", async () => {
    const root = await project();
    const io = adapters(["y", "y", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const push = io.calls.find((call) => call.args.includes("push"));
    expect(push?.args.slice(-2)).toEqual(["origin", `${head}:refs/heads/main`]);
    expect(push?.args.some((argument) => argument.startsWith("--force"))).toBe(false);
  });
  it("commits only its workflow after consent while preserving user edits and bypassing repository hooks", async () => {
    const root = await project();
    await writeFile(join(root, "README.md"), "user edit\n");
    await writeFile(join(root, "notes.txt"), "user file\n");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho unsafe > hook-ran.txt\n", { mode: 0o755 });
    const io = adapters(["y", "y", "y", "n"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    const changed = await exec(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { cwd: root },
    );
    expect(changed.stdout.trim()).toBe(".github/workflows/dsh-review.yml");
    expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout).toBe("");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("user edit\n");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("user file\n");
    await expect(readFile(join(root, "hook-ran.txt"))).rejects.toThrow();
    expect(io.calls.some((call) => call.args.includes("push"))).toBe(false);
    expect(io.questions.filter((question) => question.startsWith("Commit"))).toHaveLength(1);
    expect(io.questions.filter((question) => question.startsWith("Push"))).toHaveLength(1);
  });
  it("resumes after manual login by preserving its exact generated workflow", async () => {
    const root = await project();
    const first = adapters(["y"], { login: false });
    await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...first,
    });
    const before = await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8");
    const resumed = adapters(["y", "y", "n"], { secret: "resume-fixture-key" });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...resumed,
    });
    expect(result.createdFiles).toEqual([]);
    expect(result.onboarding?.secret).toBe("configured");
    expect(await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8")).toBe(before);
    expect(resumed.output.text).toContain("Preserved");
  });
  it("sets a confirmed Secret through gh stdin without putting the value in args or output", async () => {
    const root = await project();
    const key = "masked-fixture-api-key";
    const io = adapters(["y", "y", "n"], { secret: key });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.secret).toBe("configured");
    const set = io.calls.find(
      (call) => call.command === "gh" && call.args[0] === "secret" && call.args[1] === "set",
    );
    expect(set?.args).toEqual(["secret", "set", "DEEPSEEK_API_KEY", "--repo", "example/sample"]);
    expect(set?.input).toBe(`${key}\n`);
    expect(io.calls.every((call) => !call.args.join(" ").includes(key))).toBe(true);
    expect(io.output.text).not.toContain(key);
  });
  it("defaults to read-only review at the Git root without exposing composition choices", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(nested);
    const io = adapters(["y", "n"], { login: false });
    const result = await runInstaller({
      argv: [],
      cwd: nested,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result).toMatchObject({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    const workflow = await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8");
    expect(workflow).toContain(`deepseek-harness-action@${releaseSha}`);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain('allow-write: "false"');
    expect(io.questions.join("\n")).not.toMatch(/Controlled|Native|DSH mode/u);
    expect(io.output.text).toContain("gh auth login");
    expect(io.calls.some((call) => call.args.includes("push"))).toBe(false);
  });
});
