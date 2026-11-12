import { run } from "./init-command.ts";

process.exitCode = await run(process.argv.slice(2), process.env, process);
