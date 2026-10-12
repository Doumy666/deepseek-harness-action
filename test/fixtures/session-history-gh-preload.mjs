// Only replace the external gh process; retain the actual execFileSync buffer and timeout.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, URL } from "node:url";

const execute = childProcess.execFileSync;
const adapter = fileURLToPath(new URL("./session-history-gh.mjs", import.meta.url));
childProcess.execFileSync = (command, args, options) => {
  if (command !== "gh") throw new Error("Unexpected external process");
  const record = { args, maxBuffer: options.maxBuffer, timeout: options.timeout };
  try {
    return execute(process.execPath, [adapter, ...args], options);
  } catch (error) {
    record.errorCode = error.code;
    throw error;
  } finally {
    appendFileSync(process.env.SESSION_TEST_GH_CALLS, JSON.stringify(record) + "\n");
  }
};
syncBuiltinESMExports();
