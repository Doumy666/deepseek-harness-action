import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW_PATH = ".github/workflows/dsh-review.yml";
const SHA = /^[0-9a-f]{40}$/u;
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh" };
  let committed = false;
  const prefix = [
    "-c",
    `core.hooksPath=${temporary}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
  ];
  const git = async (args, input, index = false) => {
    const result = await invoke("git", [...prefix, ...args], root, input, {
      env: index ? { ...env, GIT_INDEX_FILE: join(temporary, "index") } : env,
    });
    if (result.exitCode !== 0)
      throw new Error(
        "Git operation failed; check local Git identity, branch and permissions, then rerun.",
      );
    return result.stdout.trim();
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
    await git(["-c", "push.followTags=false", "push", "origin", `${commit}:${ref}`]);
    output.write(`Pushed the workflow commit to origin/${branch}.\n`);
    return { committed: true, pushed: true };
  } catch (error) {
    output.write(`${error.message}\n`);
    return { committed, pushed: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
