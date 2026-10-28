/** The column types the tables share. */
import {
  customType,
  timestamp,
} from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
