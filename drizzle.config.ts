import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.PID_DB_PATH ?? "./pid.sqlite",
  },
} satisfies Config;
