import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW_PATH = ".github/workflows/dsh-review.yml";
const SHA = /^[0-9a-f]{40}$/u;
const OBJECT_COMMANDS = new Set([
  "diff",
  "rev-parse",
  "read-tree",
  "hash-object",
  "update-index",
  "write-tree",
  "diff-tree",
  "commit-tree",
  "update-ref",
]);
const confirmed = (answer) => ["y", "yes"].includes(answer.trim().toLowerCase());

/** Publish only the generated workflow, with separate local/remote consent. */
export async function publishReviewWorkflow({
  root,
  prompt,
  output,
  invoke,
  remoteUrl,
  expectedContents,
}) {
  const skipped = { committed: false, pushed: false };
  if (
    !confirmed(
      await prompt.question(
        "Commit only .github/workflows/dsh-review.yml (unsigned; repository hooks are not run)? [y/N]: ",
      ),
    )
  )
    return skipped;
  const temporary = await mkdtemp(join(tmpdir(), "dsh-installer-git-"));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GIT_NO_LAZY_FETCH: "1",
  };
  let committed = false;
  const prefix = [
    // Unlike an unknown env variable, an unsupported flag makes older Git fail closed.
    "--no-lazy-fetch",
    "-c",
    `core.hooksPath=${temporary}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "push.followTags=false",
    "-c",
    "push.negotiate=false",
  ];
  const git = async (args, input, index = false) => {
    const transport = args[0] === "ls-remote" || args[0] === "push";
    if (transport || OBJECT_COMMANDS.has(args[0])) await verifyProgramConfiguration(transport);
    const result = await invoke("git", [...prefix, ...args], root, input, {
      env: index ? { ...env, GIT_INDEX_FILE: join(temporary, "index") } : env,
    });
    if (result.exitCode !== 0)
      throw new Error(
        "Git operation failed; use Git with --no-lazy-fetch support and the required objects available locally, then check identity, branch and permissions before rerunning.",
      );
    return result.stdout.trim();
  };
  const verifyProgramConfiguration = async (transport) => {
    // Names/scopes include inherited files without reading or copying auth values.
    // The host's system/global helpers stay owned by Git; repository/worktree
    // helpers require manual publication rather than executing with host access.
    // Object operations also reject alternate-ref programs, without treating
    // purely local publication as consent to run any authentication helper.
    const metadata = await git([
      "config",
      "--includes",
      "--show-scope",
      "--name-only",
      "--null",
      "--list",
    ]);
    const fields = metadata.split("\0");
    const denied = () => {
      throw new Error(
        `Git repository-scoped ${transport ? "transport" : "object command"} configuration is unsupported. Generated files and any completed local commit are preserved; inspect the configuration and publish manually, or configure trusted helpers at host scope.`,
      );
    };
    if (fields.pop() !== "" || fields.length === 0 || fields.length % 2 !== 0) denied();
    for (let index = 0; index < fields.length; index += 2) {
      const scope = fields[index];
      const key = fields[index + 1]?.toLowerCase();
      if (!["system", "global", "local", "worktree", "command"].includes(scope) || !key) denied();
      if (
        ["local", "worktree"].includes(scope) &&
        (key === "core.alternaterefscommand" ||
          (transport &&
            /^(?:core\.(?:sshcommand|gitproxy|askpass)|credential(?:\.[\s\S]+)?\.helper|remote\.[\s\S]+\.(?:vcs|uploadpack|receivepack))$/u.test(
              key,
            )))
      )
        denied();
    }
  };
  const verifyPushDestination = async () => {
    const urls = (await git(["remote", "get-url", "--push", "--all", "origin"])).split("\n");
    if (urls.length !== 1 || urls[0] !== remoteUrl.trim())
      throw new Error(
        "Origin must have a single verified push destination matching its GitHub remote. The local commit is preserved; inspect your remotes before pushing manually.",
      );
  };
  try {
    const staged = await git([
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
    ]);
    if (staged !== "") {
      output.write(
        "Existing staged changes were preserved. Finish or unstage them yourself before rerunning; no installer commit was created.\n",
      );
      return skipped;
    }
    const branch = await git(["symbolic-ref", "--short", "HEAD"]);
    await git(["check-ref-format", "--branch", branch]);
    let parent = await git(["rev-parse", "HEAD"]);
    if (!SHA.test(parent))
      throw new Error(
        "An existing committed GitHub branch is required; create its initial commit yourself and rerun.",
      );
    for (const path of [
      join(root, ".github"),
      join(root, ".github/workflows"),
      join(root, WORKFLOW_PATH),
    ]) {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(
          "Workflow destination became a symbolic link. No commit was created; inspect it before continuing.",
        );
    }
    const contents = await readFile(join(root, WORKFLOW_PATH), "utf8");
    if (contents !== expectedContents)
      throw new Error(
        "The workflow changed after its configuration check. No installer commit was created; preserve and review the edit manually.",
      );
    await git(["read-tree", parent], undefined, true);
    const blob = await git(["hash-object", "-w", "--no-filters", "--stdin"], contents, true);
    if (!SHA.test(blob)) throw new Error("Git did not return a valid workflow object identity.");
    await git(
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${WORKFLOW_PATH}`],
      undefined,
      true,
    );
    const tree = await git(["write-tree"], undefined, true);
    const parentTree = await git(["rev-parse", "HEAD^{tree}"]);
    let commit;
    if (tree === parentTree) {
      const changed = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
      if (changed !== WORKFLOW_PATH) {
        output.write(
          "The workflow is already committed. Other commits are outside this installer's publication scope; push or merge them yourself.\n",
        );
        return skipped;
      }
      commit = parent;
      parent = await git(["rev-parse", "HEAD^"]);
      committed = true;
      output.write(
        "Preserved the existing workflow-only commit; no duplicate commit was created.\n",
      );
    } else {
      commit = await git(
        ["commit-tree", tree, "-p", parent, "-m", "Configure DeepSeek PR Review"],
        undefined,
        true,
      );
      if (!SHA.test(commit))
        throw new Error("Git did not return a valid installer commit identity.");
      // Recheck the user's index before the atomic ref advance. No hook, filter,
      // repository script, unrelated staged path, or signing process is executed.
      if (
        (await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z"])) !==
          "" ||
        (await git(["symbolic-ref", "--short", "HEAD"])) !== branch
      )
        throw new Error(
          "Git state changed during setup. No branch was advanced; inspect the repository before retrying.",
        );
      await git(["update-ref", `refs/heads/${branch}`, commit, parent]);
      committed = true;
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${WORKFLOW_PATH}`]);
      output.write(`Committed only ${WORKFLOW_PATH} on ${branch}.\n`);
    }
    if (!confirmed(await prompt.question(`Push this new commit to origin/${branch}? [y/N]: `)))
      return { committed: true, pushed: false };
    await verifyPushDestination();
    const ref = `refs/heads/${branch}`;
    const published = await git(["ls-remote", "--heads", "origin", ref]);
    if (published === `${commit}\t${ref}`) {
      output.write("The workflow commit is already published; no push was repeated.\n");
      return { committed: true, pushed: true };
    }
    if (published !== `${parent}\t${ref}`)
      throw new Error(
        "The remote branch is missing or differs from the installer commit's parent. The local commit is preserved; reconcile unpublished or concurrent commits before pushing manually.",
      );
    if (
      (await git(["rev-parse", "HEAD"])) !== commit ||
      (await git(["symbolic-ref", "--short", "HEAD"])) !== branch
    )
      throw new Error(
        "Local branch changed before push. No push was attempted; inspect it before continuing.",
      );
    await verifyPushDestination();
    await git(["push", "--no-signed", "--recurse-submodules=no", "origin", `${commit}:${ref}`]);
    output.write(`Pushed the workflow commit to origin/${branch}.\n`);
    return { committed: true, pushed: true };
  } catch (error) {
    output.write(`${error.message}\n`);
    return { committed, pushed: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
