import { bootstrap } from "./bootstrap.js";
import { readFileSync } from "node:fs";

try {
  const password = process.env.BOOTSTRAP_PASSWORD_FILE
    ? readFileSync(process.env.BOOTSTRAP_PASSWORD_FILE, "utf8").replace(
        /\r?\n$/,
        "",
      )
    : process.env.BOOTSTRAP_PASSWORD;
  await bootstrap({ ...process.env, BOOTSTRAP_PASSWORD: password });
  console.info(JSON.stringify({ event: "initial_bootstrap_completed" }));
} catch {
  // Do not print adapter errors, connection strings or operator inputs.
  console.error(
    JSON.stringify({ event: "initial_bootstrap_refused_or_failed" }),
  );
  process.exitCode = 1;
}
