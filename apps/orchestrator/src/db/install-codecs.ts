import pg from "pg";
import { parseInt8 } from "./codecs.js";

const TIMESTAMPTZ_OID = 1184;
const INT8_OID = 20;
const NUMERIC_OID = 1700;

let installed = false;

export function installCodecs(): void {
  if (installed) {
    return;
  }
  pg.types.setTypeParser(INT8_OID, parseInt8);
  pg.types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => value);
  pg.types.setTypeParser(NUMERIC_OID, (value: string) => value);
  installed = true;
}
