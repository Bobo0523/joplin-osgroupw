import { Expression, RawBuilder, sql } from 'kysely';
import { SqlParams } from './types';

// This is the only file that is allowed to use Kysely's `sql` template tag.
// It holds the SQL that Kysely's query builder cannot express, such as
// SQLite-specific syntax, so that every such use can be reviewed in one place.
// The full list is in MIGRATION_PLAN.md, under "sql tag inventory".

// Turns a legacy SQL fragment with `?` placeholders, as accepted by options
// such as `where`/`whereParams` and `conditions`/`conditionsParams`, into a
// Kysely expression. The fragment text is used as-is, as it was before.
export const legacyFragment = <T = unknown>(fragment: string, params: SqlParams = []): RawBuilder<T> => {
	const parts = fragment.split('?');
	if (parts.length === 1) return sql<T>`${sql.raw(fragment)}`;
	const pieces: RawBuilder<unknown>[] = [];
	for (let i = 0; i < parts.length; i++) {
		if (parts[i]) pieces.push(sql.raw(parts[i]));
		if (i < parts.length - 1) pieces.push(sql`${params[i]}`);
	}
	return sql<T>`${sql.join(pieces, sql.raw(''))}`;
};

export type LegacyCondition = string | Expression<unknown>;

// Joins conditions with AND, exactly as the original `conditions.join(' AND ')`
// did (without adding brackets). String conditions take their parameters, in
// order, from `params`.
export const legacyConditions = (conditions: readonly LegacyCondition[], params: SqlParams = []) => {
	let paramIndex = 0;
	const pieces = conditions.map(condition => {
		if (typeof condition !== 'string') return condition;
		const paramCount = condition.split('?').length - 1;
		const conditionParams = params.slice(paramIndex, paramIndex + paramCount);
		paramIndex += paramCount;
		return legacyFragment(condition, conditionParams);
	});
	return sql<boolean>`${sql.join(pieces, sql.raw(' AND '))}`;
};

// Kysely leaves out columns whose value is `undefined`, whereas the original
// queries bound them as NULL. This keeps the value as a bound parameter.
export const boundValue = (value: unknown) => sql`${value}`;

// Writes the values directly into the SQL as escaped string literals, as
// `escapeValues()` did, rather than as bound parameters. Older SQLite
// versions (as used on some Android devices) limit the number of parameters
// in a query to 999, which a long list of IDs would exceed.
export const literalList = (values: readonly (string | number)[]) => sql<string>`(${sql.join(values.map(v => sql.lit(v)))})`;

// Equivalent to "`field` = ? COLLATE NOCASE". As in the original queries,
// the collation only applies to this comparison.
export const equalsCollateNocase = (fieldName: string, value: unknown) => sql<boolean>`${sql.id(fieldName)} = ${value} COLLATE NOCASE`;

// Used for ORDER BY items that Kysely's builder cannot reproduce exactly: a
// direction other than ASC/DESC is written as-is into the query, and a field
// name is treated as a single identifier even if it contains a dot.
export const rawOrderItem = (fieldName: string, collateNocase: boolean, direction: string) => {
	return sql`${sql.id(fieldName)}${sql.raw(collateNocase ? ' COLLATE NOCASE' : '')} ${sql.raw(String(direction))}`;
};

// FTS4 auxiliary functions, used by the search engine to rank the results.
export const ftsOffsets = (tableName: 'notes_fts' | 'items_fts') => sql<string>`offsets(${sql.table(tableName)})`;
export const ftsMatchInfo = (tableName: 'notes_fts' | 'items_fts') => sql<Buffer>`matchinfo(${sql.table(tableName)}, 'pcnalx')`;

// FTS4 full-text MATCH, either against a whole FTS table or one of its columns.
export const ftsMatch = (tableOrColumnName: string, query: string) => sql<boolean>`${sql.ref(tableOrColumnName)} MATCH ${query}`;

// sqlite-vec (vec0) syntax, used for the AI embeddings index. vec0 needs the
// dimension and `k` written directly into the query, and the LIMIT after a
// JOIN must also be a literal for its query planner to see it.
export const createVecTableQuery = (dimension: number) => sql`CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings_vec USING vec0(embedding FLOAT[${sql.lit(dimension)}])`;
export const vecKnnMatch = (columnName: string, vectorJson: string, k: number) => sql<boolean>`${sql.ref(columnName)} MATCH ${vectorJson} AND k = ${sql.lit(k)}`;
export const vecToJson = (columnName: string) => sql<string>`vec_to_json(${sql.ref(columnName)})`;
export const literalNumber = (value: number) => sql<number>`${sql.lit(value)}`;

export interface ConnectiveItem {
	connective: 'AND' | 'OR';
	expression: Expression<unknown>;
}

// Joins conditions in a flat chain such as "a AND b OR c", without brackets,
// so that SQL's own precedence rules apply, as in the search query builder's
// original string-built queries.
export const connectiveChain = (first: Expression<unknown>, items: readonly ConnectiveItem[]) => {
	const pieces: Expression<unknown>[] = [first];
	for (const item of items) pieces.push(sql`${sql.raw(item.connective === 'OR' ? 'OR' : 'AND')} ${item.expression}`);
	return sql<boolean>`${sql.join(pieces, sql.raw(' '))}`;
};

// Schema setup and upgrade steps (JoplinDatabase and services/database/migrations).

// Kysely's builder has no INT column type (only INTEGER). The two are
// equivalent in SQLite except for primary keys, but the existing profiles use
// INT, so it is kept.
export const intColumnType = sql`INT`;

// SQLite's virtual tables and triggers have no Kysely builder. These are
// written exactly as in the original upgrade steps, because SQLite stores
// their text in the schema.
export const createFtsTableQuery = (ftsTableName: string, options: readonly string[], columnNames: readonly string[]) => {
	return sql`CREATE VIRTUAL TABLE ${sql.raw(ftsTableName)} USING fts4(${sql.raw([...options, ...columnNames].join(', '))})`;
};

export const createVirtualTableQuery = (tableName: string, moduleName: string) => sql`CREATE VIRTUAL TABLE ${sql.raw(tableName)} USING ${sql.raw(moduleName)}`;

export interface FtsTriggerOptions {
	ftsTableName: string;
	contentTableName: string;
	columnNames: readonly string[];
	// Names of the four triggers, in this order: before update, before
	// delete, after update, after insert.
	triggerNames: readonly [string, string, string, string];
	// Extra condition on the content table for a row to be indexed.
	indexCondition?: string;
}

// Triggers that keep an external content FTS4 table in sync with its content
// table: https://www.sqlite.org/fts3.html#_external_content_fts4_tables_
export const createFtsTriggerQueries = (options: FtsTriggerOptions) => {
	const fts = sql.raw(options.ftsTableName);
	const content = sql.raw(options.contentTableName);
	const columns = sql.raw(options.columnNames.join(', '));
	const condition = sql.raw(options.indexCondition ? `${options.indexCondition} AND ` : '');
	const [beforeUpdate, beforeDelete, afterUpdate, afterInsert] = options.triggerNames.map(name => sql.raw(name));
	return [
		sql`CREATE TRIGGER ${beforeUpdate} BEFORE UPDATE ON ${content} BEGIN DELETE FROM ${fts} WHERE docid=old.rowid; END;`,
		sql`CREATE TRIGGER ${beforeDelete} BEFORE DELETE ON ${content} BEGIN DELETE FROM ${fts} WHERE docid=old.rowid; END;`,
		sql`CREATE TRIGGER ${afterUpdate} AFTER UPDATE ON ${content} BEGIN INSERT INTO ${fts}(docid, ${columns}) SELECT rowid, ${columns} FROM ${content} WHERE ${condition}new.rowid = ${content}.rowid; END;`,
		sql`CREATE TRIGGER ${afterInsert} AFTER INSERT ON ${content} BEGIN INSERT INTO ${fts}(docid, ${columns}) SELECT rowid, ${columns} FROM ${content} WHERE ${condition}new.rowid = ${content}.rowid; END;`,
	];
};

export const dropTriggerQuery = (triggerName: string, ifExists = false) => sql`DROP TRIGGER ${sql.raw(ifExists ? 'IF EXISTS ' : '')}${sql.raw(triggerName)}`;

// Copies all the rows of the content table into a new FTS table, including
// the hidden rowid, which becomes the FTS docid.
export const ftsInitialIndexQuery = (ftsTableName: string, contentTableName: string, columnNames: readonly string[], indexCondition: string) => {
	const columns = sql.raw(columnNames.join(', '));
	return sql`INSERT INTO ${sql.raw(ftsTableName)}(docid, ${columns}) SELECT rowid, ${columns} FROM ${sql.raw(contentTableName)} WHERE ${sql.raw(indexCondition)}`;
};

export const tableInfoQuery = (tableName: string) => sql`PRAGMA table_info(${sql.id(tableName)})`;
