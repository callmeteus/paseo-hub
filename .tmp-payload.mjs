import { PGlite } from "@electric-sql/pglite";
import { writeFileSync } from "node:fs";
const db = new PGlite("/tmp/opencode/hub-local-backup/hub-data");
const s = (await db.query("select bot_access_token,scopes from slack_connections limit 1")).rows[0];
await db.close();
writeFileSync("/tmp/opencode/slack-data.json", JSON.stringify(s));
