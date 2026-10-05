import { ColumnDataType, ColumnDefinitionBuilder, CompiledQuery, Compilable, DummyDriver, Expression, expressionBuilder, Kysely, RawBuilder, SelectQueryBuilder, SqlBool, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { AlarmEntity, ConflictNoteStateEntity, DeletedItemEntity, FolderEntity, ItemChangeEntity, ItemsNormalizedEntity, KeyValueEntity, MigrationEntity, NoteEmbeddingsMetaEntity, NoteEntity, NoteResourceEntity, NoteTagEntity, NotesNormalizedEntity, ResourceEntity, ResourceLocalStateEntity, ResourcesToDownloadEntity, RevisionEntity, SettingEntity, SqlParams, SqlQuery, SyncItemEntity, TableFieldEntity, TagEntity, TagsWithNoteCountEntity, VersionEntity } from './types';
import type { Row } from '../../database';
import type { MasterKeyEntity } from '../e2ee/types';

interface FtsColumns {
	docid: number;
	rowid: number;
}

interface SqliteMasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string;
}

interface SqliteSequenceRow {
	name: string;
	seq: number;
}

interface SearchAuxRow {
	term: string;
	col: string;
	documents: number;
	occurrences: number;
}

interface NotesSpellfixRow {
	word: string;
	rank: number;
	distance: number;
	score: number;
	top: number;
	scope: number;
}

interface NoteEmbeddingsVecRow {
	rowid: number;
	embedding: unknown;
	distance: number;
	k: number;
}

export interface DatabaseSchema {
	alarms: AlarmEntity;
	conflict_note_states: ConflictNoteStateEntity;
	deleted_items: DeletedItemEntity;
	folders: FolderEntity;
	item_changes: ItemChangeEntity;
	items_fts: ItemsNormalizedEntity & FtsColumns;
	items_normalized: ItemsNormalizedEntity;
	key_values: KeyValueEntity;
	master_keys: MasterKeyEntity;
	migrations: MigrationEntity;
	note_embeddings_meta: NoteEmbeddingsMetaEntity;
	note_embeddings_vec: NoteEmbeddingsVecRow;
	note_resources: NoteResourceEntity;
	note_tags: NoteTagEntity;
	notes: NoteEntity;
	notes_fts: NotesNormalizedEntity & FtsColumns;
	notes_normalized: NotesNormalizedEntity;
	notes_spellfix: NotesSpellfixRow;
	resource_local_states: ResourceLocalStateEntity;
	resources: ResourceEntity;
	resources_to_download: ResourcesToDownloadEntity;
	revisions: RevisionEntity;
	search_aux: SearchAuxRow;
	settings: SettingEntity & { type?: number };
	sqlite_master: SqliteMasterRow;
	sqlite_sequence: SqliteSequenceRow;
	sync_items: SyncItemEntity;
	table_fields: TableFieldEntity;
	tags: TagEntity;
	tags_with_note_count: TagsWithNoteCountEntity;
	version: VersionEntity;
}

export type TableName = keyof DatabaseSchema;

// Used when the table or column names are only known at runtime, for example
// in BaseModel where the table name comes from the subclass. Rows have the
// same loose type as the rows returned by the Database class.
export type DynamicSchema = Record<string, Row>;

// Kysely is only used to build and compile queries. They are executed by the
// Database class, which keeps handling the platform-specific drivers, retries,
// logging and transactions.
export const qb = new Kysely<DatabaseSchema>({
	dialect: {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: db => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	},
});

export const dynamicQb = qb as unknown as Kysely<DynamicSchema>;

// Builds conditions on the given table, outside of a query, for example to
// build a list of conditions that are applied to a query later on.
export const conditionBuilder = <T extends TableName>() => expressionBuilder<DatabaseSchema, T>();

export const dynamicConditionBuilder = () => expressionBuilder<DynamicSchema, string>();

export type Query<O = unknown> = Compilable<O> | RawBuilder<O> | CompiledQuery<O>;

export type QueryOrSql = Query | SqlQuery | string;

export type ColumnDefinition = [ColumnDataType, ((column: ColumnDefinitionBuilder)=> ColumnDefinitionBuilder)?];

const isRawBuilder = (query: unknown): query is RawBuilder<unknown> => {
	return !!query && typeof query === 'object' && (query as RawBuilder<unknown>).isRawBuilder === true;
};

const isCompiledQuery = (query: unknown): query is CompiledQuery => {
	return !!query && typeof query === 'object' && 'query' in query && 'parameters' in query && 'sql' in query;
};

export const isQuery = (query: unknown): query is Query => {
	if (!query || typeof query !== 'object') return false;
	return isRawBuilder(query) || isCompiledQuery(query) || typeof (query as Compilable).compile === 'function';
};

export const compileQuery = (query: Query): SqlQuery => {
	let compiled: CompiledQuery;
	if (isRawBuilder(query)) {
		compiled = query.compile(qb);
	} else if (isCompiledQuery(query)) {
		compiled = query;
	} else {
		compiled = query.compile();
	}
	return { sql: compiled.sql, params: compiled.parameters.slice() };
};

export const toSqlQuery = (query: QueryOrSql, params: SqlParams = null): SqlQuery => {
	if (typeof query === 'string') return { sql: query, params };
	if (isQuery(query)) return compileQuery(query);
	return query;
};

// Kysely drops the properties that are undefined from inserted or updated
// values, which means the column default would be used instead of NULL. This
// keeps them so that the query is the same as the one that was previously
// built manually.
export const keepUndefinedValues = (values: object) => {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		output[key] = value === undefined ? sql.val(undefined) : value;
	}
	return output;
};

// Inlines the values in the generated SQL instead of passing them as
// parameters. This is used for potentially long lists of IDs, so that the
// query is not affected by the SQLite limit on the number of parameters.
export const literalList = <T extends string | number>(values: T[]) => {
	return values.map(v => sql.lit<T>(v));
};

// Converts a legacy SQL condition string such as `id = ? OR title LIKE ?` to a
// Kysely expression, binding each `?` placeholder to the corresponding param.
// The condition is not wrapped in parentheses so that combining it with other
// conditions behaves exactly as when the strings were joined with AND.
export const sqlCondition = (condition: string, params: SqlParams = null): Expression<SqlBool> => {
	const parts = condition.split('?');
	const values = params ? params : [];

	const chunks: RawBuilder<unknown>[] = [];
	for (let i = 0; i < parts.length; i++) {
		chunks.push(sql.raw(parts[i]));
		if (i < parts.length - 1) chunks.push(sql`${values[i]}`);
	}

	return sql<SqlBool>`${sql.join(chunks, sql.raw(''))}`;
};

export type Condition = Expression<SqlBool>;

// Accepts either Kysely expressions or legacy SQL condition strings. The legacy
// params are consumed in order by the `?` placeholders of the string
// conditions.
export const toConditions = (conditions: (string | Condition)[], params: SqlParams = null) => {
	const remainingParams = params ? params.slice() : [];
	return conditions.map(condition => {
		if (typeof condition !== 'string') return condition;
		const placeholderCount = condition.split('?').length - 1;
		return sqlCondition(condition, remainingParams.splice(0, placeholderCount));
	});
};

// Selects the given fields, where "*" means all the fields. Fields may be
// prefixed with the table name, as in "notes.id".
export const selectFields = <O>(query: SelectQueryBuilder<DynamicSchema, string, O>, fields: string | string[]) => {
	if (!fields || fields === '*') return query.selectAll();
	const fieldList = typeof fields === 'string' ? [fields] : fields;
	if (fieldList.includes('*')) return query.selectAll();
	return query.select(fieldList);
};

export { sql };
