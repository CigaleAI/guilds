/** The bounds a number or time column falls between, each inclusive. */
export type RecordRange = { gte?: number | string; lte?: number | string };

/** What one column must hold for a record to match: a value, null for empty, or a range. */
export type RecordCondition = string | number | boolean | null | RecordRange;

/** The `where` of a records query: each filtered column's condition, by column name. */
export type RecordWhere = Record<string, RecordCondition>;
