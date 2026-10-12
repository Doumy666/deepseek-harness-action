// Synthetic GitHub transport. No network, credentials, model or internal fixture mocking.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "--method" || args[2] !== "GET")
  throw new Error("Unexpected external request");
const responses = JSON.parse(readFileSync(process.env.SESSION_TEST_GH_RESPONSES, "utf8"));
const value = responses[args[3]];
if (value === undefined) throw new Error("Unexpected GitHub route");
if (args.length === 4) {
  process.stdout.write(
    value.archive === undefined ? JSON.stringify(value) : Buffer.from(value.archive, "base64"),
  );
} else {
  // Model only the fixed, shape-preserving gh jq projection at this external seam.
  const projection =
    '{workflow_runs: (.workflow_runs | if type == "array" then map(if type == "object" then {id, path, event, display_title, status, conclusion} else . end) else . end)} + (if has("total_count") then {total_count} else {} end)';
  if (args.length !== 6 || args[4] !== "--jq" || args[5] !== projection)
    throw new Error("Unexpected GitHub projection");
  const runs = value.workflow_runs;
  process.stdout.write(
    JSON.stringify({
      ...(Object.hasOwn(value, "total_count") ? { total_count: value.total_count } : {}),
      workflow_runs: Array.isArray(runs)
        ? runs.map((run) =>
            run !== null && typeof run === "object" && !Array.isArray(run)
              ? Object.fromEntries(
                  ["id", "path", "event", "display_title", "status", "conclusion"].map((key) => [
                    key,
                    run[key] ?? null,
                  ]),
                )
              : run,
          )
        : (runs ?? null),
    }),
  );
}
