import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Local (simulated) D1 only — tests never touch the remote database.
await applyD1Migrations(env.DB, (env as any).TEST_MIGRATIONS);
