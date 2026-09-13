/** Manual scheduler run, for cron-style deployment or local verification. */
import { tickOnce, dailySweep } from "./scheduler.js";
import { closePool } from "../db/index.js";

const mode = process.argv[2] ?? "tick";
const out = mode === "sweep" ? { reactivationsScheduled: await dailySweep() } : await tickOnce();
console.log(JSON.stringify(out));
await closePool();
