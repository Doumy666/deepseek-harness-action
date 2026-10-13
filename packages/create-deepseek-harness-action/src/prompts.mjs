import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/** One terminal session keeps buffered answers and suppresses secret echo. */
export function createPrompter(input, output) {
  const terminal = Boolean(input.isTTY && output.isTTY && input.setRawMode);
  let muted = false;
  const display = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const readline = createInterface({ input, output: display, terminal });
  const answers = readline[Symbol.asyncIterator]();
  const next = async () => {
    const answer = await answers.next();
    if (answer.done) throw new Error("Interactive input ended; rerun the installer to resume.");
    return answer.value;
  };
  return {
    async question(message) {
      output.write(message);
      return next();
    },
    async secret(message) {
      if (!terminal)
        throw new Error(
          "Hidden secret input needs a real terminal; use GitHub Settings > Secrets and variables > Actions.",
        );
      output.write(message);
      muted = true;
      try {
        return await next();
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    close() {
      readline.close();
    },
  };
}
