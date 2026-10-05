import { ColumnDefinition, dynamicQb, qb, Query } from './kysely';

// Column definitions used by the database migrations. In SQLite, "integer"
// has the same affinity as the "INT" type that was used in the original
// migrations.
export const column = {
	textPrimaryKey: (): ColumnDefinition => ['text', c => c.primaryKey()],
	integerPrimaryKey: (): ColumnDefinition => ['integer', c => c.primaryKey()],
	autoIncrementPrimaryKey: (): ColumnDefinition => ['integer', c => c.primaryKey().autoIncrement()],
	text: (defaultValue: string = null): ColumnDefinition => ['text', c => defaultValue === null ? c.notNull() : c.notNull().defaultTo(defaultValue)],
	integer: (defaultValue: number = null): ColumnDefinition => ['integer', c => defaultValue === null ? c.notNull() : c.notNull().defaultTo(defaultValue)],
	numeric: (defaultValue: number): ColumnDefinition => ['numeric', c => c.notNull().defaultTo(defaultValue)],
	nullableText: (): ColumnDefinition => ['text'],
	nullableInteger: (): ColumnDefinition => ['integer'],
};

// Deletes the content of the tables and resets their autoincremented IDs.
export const clearTablesQueries = (tableNames: string[]) => {
	const queries: Query[] = [];
	for (const n of tableNames) {
		queries.push(dynamicQb.deleteFrom(n));
		queries.push(qb.deleteFrom('sqlite_sequence').where('name', '=', n));
	}
	return queries;
};

interface CreateTableOptions {
	ifNotExists?: boolean;
	temporary?: boolean;
}

export const createTable = (tableName: string, columns: Record<string, ColumnDefinition>, options: CreateTableOptions = null) => {
	let query = dynamicQb.schema.createTable(tableName);
	if (options?.ifNotExists) query = query.ifNotExists();
	if (options?.temporary) query = query.temporary();
	for (const [name, [type, build]] of Object.entries(columns)) {
		query = query.addColumn(name, type, build ? build : c => c);
	}
	return query;
};

export const addColumn = (tableName: string, columnName: string, [type, build]: ColumnDefinition) => {
	return dynamicQb.schema.alterTable(tableName).addColumn(columnName, type, build ? build : c => c);
};

interface CreateIndexOptions {
	ifNotExists?: boolean;
	unique?: boolean;
}

export const createIndex = (indexName: string, tableName: string, columns: string | string[], options: CreateIndexOptions = null) => {
	let query = dynamicQb.schema.createIndex(indexName).on(tableName).columns(typeof columns === 'string' ? [columns] : columns);
	if (options?.ifNotExists) query = query.ifNotExists();
	if (options?.unique) query = query.unique();
	return query;
};

const tagsWithNoteCountQuery = (withTodoCompletedCount: boolean, excludeDeletedNotes: boolean) => {
	let query = qb.selectFrom('tags')
		.leftJoin('note_tags as nt', 'nt.tag_id', 'tags.id')
		.leftJoin('notes', 'notes.id', 'nt.note_id')
		.select(eb => [
			'tags.id as id',
			'tags.title as title',
			'tags.created_time as created_time',
			'tags.updated_time as updated_time',
			eb.fn.count('notes.id').as('note_count'),
		])
		.where('notes.id', 'is not', null);

	if (withTodoCompletedCount) {
		// eslint-disable-next-line promise/prefer-await-to-then -- This is the SQL CASE builder, not a promise
		query = query.select(eb => eb.fn.sum(eb.case().when('notes.todo_completed', '>', 0).then(1).else(0).end()).as('todo_completed_count'));
	}

	if (excludeDeletedNotes) {
		query = query.where('notes.deleted_time', '=', 0);
	}

	return query.groupBy('tags.id');
};

export const createTagsWithNoteCountView = (withTodoCompletedCount: boolean, excludeDeletedNotes: boolean, ifNotExists = false) => {
	let query = qb.schema.createView('tags_with_note_count');
	if (ifNotExists) query = query.ifNotExists();
	return query.as(tagsWithNoteCountQuery(withTodoCompletedCount, excludeDeletedNotes));
};
