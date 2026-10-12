import { ColumnDefinitionBuilder } from 'kysely';
import { dynamicKysely } from './kysely';
import { intColumnType } from './sqlFragments';

export type ColumnType = 'int' | 'integer' | 'text' | 'numeric';

export interface ColumnOptions {
	primaryKey?: boolean;
	autoIncrement?: boolean;
	notNull?: boolean;
	unique?: boolean;
	// Note that a string default such as '0' is not the same as the number 0:
	// SQLite records it as text, which matters for the default values that
	// JoplinDatabase reads back from the schema.
	default?: string | number;
}

export interface ColumnSpec extends ColumnOptions {
	name: string;
	type: ColumnType;
}

export const column = (name: string, type: ColumnType, options: ColumnOptions = {}): ColumnSpec => ({ name, type, ...options });

// The most common column definitions in the schema: `TEXT NOT NULL DEFAULT ""`
// and `INT NOT NULL DEFAULT 0`.
export const textColumn = (name: string) => column(name, 'text', { notNull: true, default: '' });
export const intColumn = (name: string, defaultValue: string | number = 0) => column(name, 'int', { notNull: true, default: defaultValue });

const applyColumnOptions = (spec: ColumnSpec) => (definition: ColumnDefinitionBuilder) => {
	if (spec.primaryKey) definition = definition.primaryKey();
	if (spec.autoIncrement) definition = definition.autoIncrement();
	if (spec.notNull) definition = definition.notNull();
	if (spec.unique) definition = definition.unique();
	if (spec.default !== undefined) definition = definition.defaultTo(spec.default);
	return definition;
};

const dataType = (type: ColumnType) => type === 'int' ? intColumnType : type;

export const createTableQuery = (tableName: string, columns: readonly ColumnSpec[], options: { ifNotExists?: boolean; temporary?: boolean } = {}) => {
	let query = dynamicKysely.schema.createTable(tableName);
	if (options.ifNotExists) query = query.ifNotExists();
	if (options.temporary) query = query.temporary();
	for (const spec of columns) query = query.addColumn(spec.name, dataType(spec.type), applyColumnOptions(spec));
	return query;
};

export const addColumnQuery = (tableName: string, spec: ColumnSpec) => {
	return dynamicKysely.schema.alterTable(tableName).addColumn(spec.name, dataType(spec.type), applyColumnOptions(spec));
};

export const createIndexQuery = (indexName: string, tableName: string, columnNames: string[], options: { unique?: boolean; ifNotExists?: boolean } = {}) => {
	let query = dynamicKysely.schema.createIndex(indexName).on(tableName).columns(columnNames);
	if (options.unique) query = query.unique();
	if (options.ifNotExists) query = query.ifNotExists();
	return query;
};

// SQLite cannot change the type of a column, so the table is copied to a
// backup table, recreated with the new columns, and copied back. Note that
// this drops the table's indexes.
export const alterColumnQueries = (tableName: string, columns: readonly ColumnSpec[]) => {
	const backupTableName = `${tableName}_backup`;
	const columnNames = columns.map(c => c.name);
	return [
		createTableQuery(backupTableName, columns, { temporary: true }),
		dynamicKysely.insertInto(backupTableName).expression(dynamicKysely.selectFrom(tableName).select(columnNames)),
		dynamicKysely.schema.dropTable(tableName),
		createTableQuery(tableName, columns),
		dynamicKysely.insertInto(tableName).expression(dynamicKysely.selectFrom(backupTableName).select(columnNames)),
		dynamicKysely.schema.dropTable(backupTableName),
	];
};
