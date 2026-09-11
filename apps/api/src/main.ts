import { readConfig } from "@socialflow/config";
import { createApplication } from "./app.js";
const config = readConfig(process.env);
const runtime = await createApplication(config);
await runtime.app.listen(config.PORT, "0.0.0.0");
console.info(JSON.stringify({ event: "api_started", port: config.PORT }));
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void runtime.close().then(() => process.exit(0));
  });
