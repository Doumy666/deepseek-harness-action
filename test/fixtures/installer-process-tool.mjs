import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setInterval } from "node:timers";

const mode = process.argv[2];
if (mode === "version") {
  process.stdout.write("gh version fixture\n");
} else {
  // A real process fixture deliberately retains inherited pipes and ignores
  // the graceful signal. No GitHub transport or credential is involved.
  process.on("SIGTERM", () => {
    /* Deliberately ignore graceful termination to test escalation. */
  });
  if (mode !== "descendant") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
      stdio: ["ignore", process.stdout, process.stderr],
      windowsHide: true,
    });
    writeFileSync(process.argv[3], JSON.stringify([process.pid, child.pid]));
    if (mode === "overflow") process.stdout.write("x".repeat(128 * 1024));
    if (mode === "orphan") process.exit(0);
  }
  setInterval(() => {
    /* Keep the real fixture alive without performing any external work. */
  }, 1000);
}
