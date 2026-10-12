import { CompiledQuery, Expression, RawBuilder, SelectQueryBuilder, sql, SqlBool } from 'kysely';
import { SqlParams } from './types';
import { kysely, KyselyQuery, SqlCondition } from './kysely';

// Converts a legacy SQL snippet using `?` placeholders (e.g. a `where` option passed in by
// another package) into a Kysely fragment, keeping the values as bound parameters.
const splitOnPlaceholders = (sqlText: string) => {
	const parts: string[] = [];
	let current = '';
	let quote = '';
	for (const c of sqlText) {
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '\'' || c === '"' || c === '`') {
			quote = c;
		} else if (c === '?') {
			parts.push(current);
			current = '';
			continue;
		}
		current += c;
	}
	parts.push(current);
	return parts;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Matches Kysely's own default for the fragment type
export const rawFragment = <T = any>(sqlText: string, params: SqlParams = null): RawBuilder<T> => {
	const parts = splitOnPlaceholders(sqlText);
	const values = params ? params : [];
	if (values.length !== parts.length - 1) throw new Error(`Parameter count mismatch: ${sqlText}: ${JSON.stringify(values)}`);
	const strings = Object.assign([...parts], { raw: [...parts] }) as TemplateStringsArray;
	return sql<T>(strings, ...values);
};

// Joins conditions with AND, without adding parentheses, exactly like the legacy
// `conditions.join(' AND ')`. `params` belong to the string conditions, in order.
export const conditionsFragment = (conditions: SqlCondition[], params: SqlParams = null): RawBuilder<SqlBool> => {
	const values = params ? params : [];
	let paramIndex = 0;
	const parts = conditions.map(condition => {
		if (typeof condition !== 'string') return condition as Expression<SqlBool>;
		const count = splitOnPlaceholders(condition).length - 1;
		const fragment = rawFragment<SqlBool>(condition, values.slice(paramIndex, paramIndex + count));
		paramIndex += count;
		return fragment;
	});
	if (paramIndex !== values.length) throw new Error(`Parameter count mismatch: ${JSON.stringify(values)}`);
	return sql<SqlBool>`${sql.join(parts, sql` AND `)}`;
};

// ---- Core CRUD helpers (database.ts, BaseModel.ts, pagination) ----

// SQLite applies the collation of the right operand, so `col = ? COLLATE NOCASE` makes only
// this comparison case-insensitive (BaseModel.loadByFields relies on this).
export const valueCollateNocase = <T>(value: T): RawBuilder<T> => {
	return sql<T>`${value} COLLATE NOCASE`;
};

// `dir` comes unchecked from callers (e.g. the REST API `order_dir`) and is pasted as-is to
// preserve the existing behaviour.
export const orderByTerm = (column: string, caseInsensitive: boolean, dir: string) => {
	const collate = caseInsensitive ? sql` COLLATE NOCASE` : sql``;
	return sql`${sql.id(column)}${collate} ${sql.raw(`${dir}`)}`;
};

// Column definitions such as 'TEXT NOT NULL DEFAULT ""' have no builder equivalent, and the
// text is kept identical to the legacy output since SQLite stores it in sqlite_master.
export const columnDefinition = (definition: string) => {
	return sql.raw(definition);
};

export const createTableFromDefinitions = (tableName: string, fields: Record<string, string>) => {
	const quote = (name: string) => `\`${name}\``;
	const columns = Object.keys(fields).map(n => `${quote(n)} ${fields[n]}`);
	return sql`CREATE TABLE ${sql.raw(quote(tableName))}(${sql.raw(columns.join(','))})`;
};

// ---- Load options ----

// Applies a LoadOptions `fields` value ('*', null or a list of columns) to a query. Call it
// last since the returned query can no longer be refined.
export const selectLoadFields = <DB, TB extends keyof DB, O>(query: SelectQueryBuilder<DB, TB, O>, fields: string | string[]): KyselyQuery => {
	if (!fields || fields === '*') return query.selectAll();
	if (typeof fields === 'string') throw new Error(`Invalid field value (only "*" is supported): ${fields}`);
	return query.select(fields.map(f => kysely.dynamic.ref<string>(f)));
};

// ---- Search: FTS4, matchinfo/offsets, search query composition and sqlite-vec ----

export type SearchFragment = RawBuilder<unknown>;

// Identifiers below are internal constants chosen by the search code, never user input. They
// are inlined unquoted so that the generated SQL text (and thus FTS column/ranking behaviour)
// stays identical to the previous string-built queries.
const ident = (name: string) => sql.raw(name);

export const ftsOffsets = (table: 'notes_fts' | 'items_fts') => sql<string>`offsets(${ident(table)})`;

export const ftsMatchInfo = (table: 'notes_fts' | 'items_fts') => sql<string>`matchinfo(${ident(table)}, 'pcnalx')`;

export const itemsFtsTitleOrBodyMatch = (query: string) => sql<boolean>`title MATCH ${query} OR body MATCH ${query}`;

export const compileSearchFragment = (fragment: SearchFragment): CompiledQuery => fragment.compile(kysely);

export const joinSearchFragments = (fragments: SearchFragment[], separator: string) => sql.join(fragments, sql.raw(separator));

export const searchSelectHead = (tableName: string, useFts: boolean, connective: string) => sql`
	SELECT
	${ident(tableName)}.id,
	${ident(tableName)}.title,
	${useFts ? sql`offsets(notes_fts) AS offsets, matchinfo(notes_fts, 'pcnalx') AS matchinfo,` : sql``}
	${ident(tableName)}.user_created_time,
	${ident(tableName)}.user_updated_time,
	${ident(tableName)}.is_todo,
	${ident(tableName)}.todo_completed,
	${ident(tableName)}.parent_id
	FROM ${ident(tableName)}
	WHERE ${ident(connective)}`;

export const searchWithRecursive = (withs: SearchFragment[], body: SearchFragment) => sql`WITH RECURSIVE ${sql.join(withs, sql.raw(','))} ${body}`;

export const searchNotebookFilterBody = (head: SearchFragment, rest: SearchFragment) => sql`${head} AND ROWID IN ( SELECT ROWID FROM notes_fts WHERE 1=0 ${rest})`;

export const searchNotebookCte = (viewName: string, folderTitles: string[]) => sql`
	${ident(viewName)}(id)
	AS (
		SELECT folders.id
		FROM folders
		WHERE id
		IN (
			SELECT id
			FROM folders
			WHERE ${sql.join(folderTitles.map(n => sql`folders.title LIKE ${n}`), sql.raw(' OR '))}
		)
		UNION ALL
		SELECT folders.id
		FROM folders
		JOIN ${ident(viewName)}
		ON folders.parent_id=${ident(viewName)}.id
	)`;

export const searchNotebookCondition = (viewName: string, tableName: string, exclude: boolean) => sql`
	AND ROWID ${sql.raw(exclude ? 'NOT' : '')} IN (
		SELECT ${ident(tableName)}.ROWID
		FROM ${ident(viewName)}
		JOIN ${ident(tableName)}
		ON ${ident(viewName)}.id=${ident(tableName)}.parent_id
	)`;

export const searchResourceNoteIds = (mime: string) => sql`
	SELECT note_resources.note_id AS id
	FROM note_resources
	WHERE note_resources.is_associated=1
	AND note_resources.resource_id IN (${sql`
	SELECT resources.id
	FROM resources
	WHERE resources.mime LIKE ${mime}`})`;

export const searchTagNoteIds = (title: string) => sql`
	SELECT note_tags.note_id AS id
	FROM note_tags
	WHERE note_tags.tag_id IN (${sql`
	SELECT tags.id
	FROM tags
	WHERE tags.title
	LIKE ${title}`})`;

export const searchAllNotesWithCte = (requirement: string, tableName: string) => sql`
		${ident(`all_notes_with_${requirement}_${tableName}`)}
		AS (
			SELECT DISTINCT ${ident(`note_${tableName}`)}.note_id AS id FROM ${ident(`note_${tableName}`)}
		)`;

export const searchNotesWithoutExcluded = (requirement: string, tableName: string, noteIds: SearchFragment) => sql`
		SELECT * FROM (
			SELECT *
			FROM ${ident(`all_notes_with_${requirement}_${tableName}`)}
			EXCEPT ${noteIds}
		)`;

export const searchNotesWithCte = (requirement: string, tableName: string, requiredNotesQuery: SearchFragment) => sql`
		${ident(`notes_with_${requirement}_${tableName}`)}
		AS (
			${requiredNotesQuery}
		)`;

export const searchNotesWithOperatorCte = (requirement: string, tableName: string, operator: string, requiredNotesQuery: SearchFragment) => sql`
		${ident(`notes_with_${requirement}_${tableName}`)}
		AS (
			SELECT ${ident(`note_${tableName}`)}.note_id as id
			FROM ${ident(`note_${tableName}`)}
			WHERE
			${sql.raw(operator === 'INTERSECT' ? '1' : '0')} ${sql.raw(operator)}
			${requiredNotesQuery}
		)`;

export const searchNotesWithCondition = (relation: string, exclude: boolean, requirement: string, tableName: string, targetTableName: string) => sql`
	${sql.raw(relation)} ROWID ${sql.raw(exclude ? 'NOT' : '')}
	IN (
		SELECT ${ident(targetTableName)}.ROWID
		FROM ${ident(`notes_with_${requirement}_${tableName}`)}
		JOIN ${ident(targetTableName)}
		ON ${ident(`notes_with_${requirement}_${tableName}`)}.id=${ident(targetTableName)}.id
	)`;

export type SearchGenericConditionType = 'sourceurl' | 'due' | 'id' | 'field';

export const searchGenericCondition = (type: SearchGenericConditionType, tableName: string, fieldName: string, negated: boolean, value: string) => {
	if (type === 'sourceurl') return sql`${ident(tableName)}.source_url ${sql.raw(negated ? 'NOT' : '')} LIKE ${value}`;
	if (type === 'due') return sql`todo_due ${sql.raw(negated ? '<' : '>=')} ${value}`;
	if (type === 'id') return sql`id ${sql.raw(negated ? 'NOT' : '')} LIKE ${value}`;
	return sql`${ident(tableName)}.${ident(fieldName)} ${sql.raw(negated ? '<' : '>=')} ${value}`;
};

export const searchGenericFilter = (relation: string, isDue: boolean, tableName: string, condition: SearchFragment) => sql`
		${sql.raw(relation)} ( ${sql.raw(isDue ? 'is_todo IS 1 AND ' : '')} ROWID IN (
			SELECT ROWID
			FROM ${ident(tableName)}
			WHERE ${condition}
		))`;

export const searchIsTodoCondition = (tableName: string, isTodo: boolean) => sql`${ident(tableName)}.is_todo IS ${sql.raw(isTodo ? '1' : '0')}`;

export const searchIsCompletedCondition = (tableName: string, completed: boolean) => sql`${ident(tableName)}.is_todo IS 1 AND ${ident(tableName)}.todo_completed IS ${sql.raw(completed ? 'NOT 0' : '0')}`;

export const searchAndCondition = (condition: SearchFragment) => sql`
			AND ${condition}`;

export const searchOrCondition = (condition: SearchFragment) => sql`
				OR ${condition}`;

export const searchOrNormalizedCondition = (condition: SearchFragment) => sql`
				OR ROWID IN (
					SELECT ROWID
					FROM notes_normalized
					WHERE ${condition}
				)`;

export const searchLikeMatch = (relation: string, negate: boolean, termName: string, param: string) => sql`${sql.raw(relation)} ${sql.raw(negate ? 'NOT' : '')} (
			${(termName === 'text' || termName === 'body') ? sql`notes.body LIKE ${param} ` : sql``}
			${sql.raw(termName === 'text' ? 'OR' : '')}
			${(termName === 'text' || termName === 'title') ? sql`notes.title LIKE ${param} ` : sql``})`;

export const searchFtsExcludeAnd = (column: string, query: string) => sql`
				AND ROWID NOT IN (
					SELECT ROWID
					FROM notes_fts
					WHERE ${ident(`notes_fts${column}`)} MATCH ${query}
				)`;

export const searchFtsExcludeOr = (column: string, query: string) => sql`
					OR ROWID IN (
						SELECT *
							FROM (
								SELECT ROWID
								FROM notes_fts
								EXCEPT
								SELECT ROWID
								FROM notes_fts
								WHERE ${ident(`notes_fts${column}`)} MATCH ${query}
						)
					)`;

export const searchFtsMatch = (relation: string, query: string) => sql`${sql.raw(relation)} notes_fts MATCH ${query}`;

export const vecCreateTable = (dimension: number) => sql`CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings_vec USING vec0(embedding FLOAT[${sql.raw(String(Math.trunc(Number(dimension))))}])`;

// vec0 needs k inlined into the MATCH clause.
export const vecEmbeddingMatch = (vector: string, k: number) => sql<boolean>`v.embedding MATCH ${vector} AND k = ${sql.raw(String(Math.trunc(Number(k))))}`;

export const vecToJson = () => sql<string>`vec_to_json(v.embedding)`;

export const lastInsertRowId = () => sql<number>`last_insert_rowid()`;

// ---- Schema setup and upgrade steps (JoplinDatabase.ts and migrations) ----

// The CREATE and ALTER statements below are kept as literal SQLite text because sqlite_master
// stores it verbatim: Kysely's schema builder lowercases and quotes it, which would change the
// stored schema of every profile. The text must stay identical to what earlier versions ran.

const statement = <O = unknown>(fragment: RawBuilder<O>): KyselyQuery<O> => ({ compile: () => fragment.compile(kysely) });

interface TableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

export type SchemaBaseItemTable = 'notes' | 'folders' | 'tags' | 'note_tags' | 'resources';

export const schemaTableInfo = (tableName: string) => statement(sql<TableInfoRow>`PRAGMA table_info(${sql.id(tableName)})`);

export const schemaStructureV1 = () => [
	statement(sql`CREATE TABLE folders (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", created_time INT NOT NULL, updated_time INT NOT NULL)`),
	statement(sql`CREATE INDEX folders_title ON folders (title)`),
	statement(sql`CREATE INDEX folders_updated_time ON folders (updated_time)`),
	statement(sql`CREATE TABLE notes (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT "", title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "", created_time INT NOT NULL, updated_time INT NOT NULL, is_conflict INT NOT NULL DEFAULT 0, latitude NUMERIC NOT NULL DEFAULT 0, longitude NUMERIC NOT NULL DEFAULT 0, altitude NUMERIC NOT NULL DEFAULT 0, author TEXT NOT NULL DEFAULT "", source_url TEXT NOT NULL DEFAULT "", is_todo INT NOT NULL DEFAULT 0, todo_due INT NOT NULL DEFAULT 0, todo_completed INT NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT "", source_application TEXT NOT NULL DEFAULT "", application_data TEXT NOT NULL DEFAULT "", \`order\` INT NOT NULL DEFAULT 0)`),
	statement(sql`CREATE INDEX notes_title ON notes (title)`),
	statement(sql`CREATE INDEX notes_updated_time ON notes (updated_time)`),
	statement(sql`CREATE INDEX notes_is_conflict ON notes (is_conflict)`),
	statement(sql`CREATE INDEX notes_is_todo ON notes (is_todo)`),
	statement(sql`CREATE INDEX notes_order ON notes (\`order\`)`),
	statement(sql`CREATE TABLE tags (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", created_time INT NOT NULL, updated_time INT NOT NULL)`),
	statement(sql`CREATE INDEX tags_title ON tags (title)`),
	statement(sql`CREATE INDEX tags_updated_time ON tags (updated_time)`),
	statement(sql`CREATE TABLE note_tags (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, tag_id TEXT NOT NULL, created_time INT NOT NULL, updated_time INT NOT NULL)`),
	statement(sql`CREATE INDEX note_tags_note_id ON note_tags (note_id)`),
	statement(sql`CREATE INDEX note_tags_tag_id ON note_tags (tag_id)`),
	statement(sql`CREATE INDEX note_tags_updated_time ON note_tags (updated_time)`),
	statement(sql`CREATE TABLE resources (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", mime TEXT NOT NULL, filename TEXT NOT NULL DEFAULT "", created_time INT NOT NULL, updated_time INT NOT NULL)`),
	statement(sql`CREATE INDEX resources_title ON resources (title)`),
	statement(sql`CREATE INDEX resources_updated_time ON resources (updated_time)`),
	statement(sql`CREATE TABLE settings (\`key\` TEXT PRIMARY KEY, \`value\` TEXT, \`type\` INT NOT NULL)`),
	statement(sql`CREATE TABLE table_fields (id INTEGER PRIMARY KEY, table_name TEXT NOT NULL, field_name TEXT NOT NULL, field_type INT NOT NULL, field_default TEXT)`),
	statement(sql`CREATE TABLE sync_items (id INTEGER PRIMARY KEY, sync_target INT NOT NULL, sync_time INT NOT NULL DEFAULT 0, item_type INT NOT NULL, item_id TEXT NOT NULL)`),
	statement(sql`CREATE INDEX sync_items_sync_time ON sync_items (sync_time)`),
	statement(sql`CREATE INDEX sync_items_sync_target ON sync_items (sync_target)`),
	statement(sql`CREATE INDEX sync_items_item_type ON sync_items (item_type)`),
	statement(sql`CREATE INDEX sync_items_item_id ON sync_items (item_id)`),
	statement(sql`CREATE TABLE deleted_items (id INTEGER PRIMARY KEY, item_type INT NOT NULL, item_id TEXT NOT NULL, deleted_time INT NOT NULL)`),
	statement(sql`CREATE TABLE version (version INT NOT NULL)`),
];

export const schemaDeletedItemsV2 = () => [
	statement(sql`CREATE TABLE deleted_items (id INTEGER PRIMARY KEY, item_type INT NOT NULL, item_id TEXT NOT NULL, deleted_time INT NOT NULL, sync_target INT NOT NULL)`),
	statement(sql`CREATE INDEX deleted_items_sync_target ON deleted_items (sync_target)`),
];

export const schemaUserTimeColumnsV5 = (table: SchemaBaseItemTable) => [
	statement(sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN user_created_time INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN user_updated_time INT NOT NULL DEFAULT 0`),
];

export const schemaUserUpdatedTimeIndexV5 = (table: SchemaBaseItemTable) => statement(sql`CREATE INDEX ${sql.raw(`${table}_user_updated_time`)} ON ${sql.raw(table)} (user_updated_time)`);

export const schemaAlarmsV6 = () => [
	statement(sql`CREATE TABLE alarms (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, trigger_time INT NOT NULL)`),
	statement(sql`CREATE INDEX alarm_note_id ON alarms (note_id)`),
];

export const schemaFileExtensionV7 = () => [
	statement(sql`ALTER TABLE resources ADD COLUMN file_extension TEXT NOT NULL DEFAULT ""`),
];

export const schemaSyncDisabledV8 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN sync_disabled INT NOT NULL DEFAULT "0"`),
	statement(sql`ALTER TABLE sync_items ADD COLUMN sync_disabled_reason TEXT NOT NULL DEFAULT ""`),
];

export const schemaMasterKeysV9 = () => statement(sql`CREATE TABLE master_keys (id TEXT PRIMARY KEY, created_time INT NOT NULL, updated_time INT NOT NULL, source_application TEXT NOT NULL, encryption_method INT NOT NULL, checksum TEXT NOT NULL, content TEXT NOT NULL)`);

export const schemaEncryptionColumnsV9 = (table: SchemaBaseItemTable) => [
	statement(sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN encryption_cipher_text TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN encryption_applied INT NOT NULL DEFAULT 0`),
	statement(sql`CREATE INDEX ${sql.raw(`${table}_encryption_applied`)} ON ${sql.raw(table)} (encryption_applied)`),
];

export const schemaEncryptionFlagsV9 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN force_sync INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE resources ADD COLUMN encryption_blob_encrypted INT NOT NULL DEFAULT 0`),
];

export const schemaItemChangesAndNoteResourcesV10 = () => [
	statement(sql`CREATE TABLE item_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_type INT NOT NULL, item_id TEXT NOT NULL, type INT NOT NULL, created_time INT NOT NULL)`),
	statement(sql`CREATE INDEX item_changes_item_id ON item_changes (item_id)`),
	statement(sql`CREATE INDEX item_changes_created_time ON item_changes (created_time)`),
	statement(sql`CREATE INDEX item_changes_item_type ON item_changes (item_type)`),
	statement(sql`CREATE TABLE note_resources (id INTEGER PRIMARY KEY, note_id TEXT NOT NULL, resource_id TEXT NOT NULL, is_associated INT NOT NULL, last_seen_time INT NOT NULL)`),
	statement(sql`CREATE INDEX note_resources_note_id ON note_resources (note_id)`),
	statement(sql`CREATE INDEX note_resources_resource_id ON note_resources (resource_id)`),
];

export const schemaFolderParentIdV12 = () => [
	statement(sql`ALTER TABLE folders ADD COLUMN parent_id TEXT NOT NULL DEFAULT ""`),
];

export const schemaResourceFetchStatusV13 = () => [
	statement(sql`ALTER TABLE resources ADD COLUMN fetch_status INT NOT NULL DEFAULT "2"`),
	statement(sql`ALTER TABLE resources ADD COLUMN fetch_error TEXT NOT NULL DEFAULT ""`),
];

export const schemaResourceLocalStatesTableV14 = () => statement(sql`CREATE TABLE resource_local_states (id INTEGER PRIMARY KEY, resource_id TEXT NOT NULL, fetch_status INT NOT NULL DEFAULT "2", fetch_error TEXT NOT NULL DEFAULT "")`);

export const schemaResourceLocalStatesIndexesV14 = () => [
	statement(sql`CREATE INDEX resource_local_states_resource_id ON resource_local_states (resource_id)`),
	statement(sql`CREATE INDEX resource_local_states_resource_fetch_status ON resource_local_states (fetch_status)`),
];

export const schemaNotesFtsV15 = () => [
	statement(sql`CREATE VIRTUAL TABLE notes_fts USING fts4(content="notes", notindexed="id", id, title, body)`),
	statement(sql`INSERT INTO notes_fts(docid, id, title, body) SELECT rowid, id, title, body FROM notes WHERE is_conflict = 0 AND encryption_applied = 0`),
	// Keep the content tables (notes) and the FTS table (notes_fts) in sync.
	// More info at https://www.sqlite.org/fts3.html#_external_content_fts4_tables_
	statement(sql`CREATE TRIGGER notes_fts_before_update BEFORE UPDATE ON notes BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_fts_before_delete BEFORE DELETE ON notes BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_update AFTER UPDATE ON notes BEGIN INSERT INTO notes_fts(docid, id, title, body) SELECT rowid, id, title, body FROM notes WHERE is_conflict = 0 AND encryption_applied = 0 AND new.rowid = notes.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_insert AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(docid, id, title, body) SELECT rowid, id, title, body FROM notes WHERE is_conflict = 0 AND encryption_applied = 0 AND new.rowid = notes.rowid; END;`),
];

const dropNotesFtsTriggers = () => [
	statement(sql`DROP TRIGGER IF EXISTS notes_fts_before_update`),
	statement(sql`DROP TRIGGER IF EXISTS notes_fts_before_delete`),
	statement(sql`DROP TRIGGER IF EXISTS notes_after_update`),
	statement(sql`DROP TRIGGER IF EXISTS notes_after_insert`),
];

export const schemaNotesNormalizedTableV18 = () => [
	statement(sql`CREATE TABLE notes_normalized (id TEXT NOT NULL, title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "")`),
	statement(sql`CREATE INDEX notes_normalized_id ON notes_normalized (id)`),
];

export const schemaNotesFtsTriggersDropV18 = dropNotesFtsTriggers;

export const schemaNotesFtsV18 = () => [
	statement(sql`CREATE VIRTUAL TABLE notes_fts USING fts4(content="notes_normalized", notindexed="id", id, title, body)`),
	statement(sql`CREATE TRIGGER notes_fts_before_update BEFORE UPDATE ON notes_normalized BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_fts_before_delete BEFORE DELETE ON notes_normalized BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_update AFTER UPDATE ON notes_normalized BEGIN INSERT INTO notes_fts(docid, id, title, body) SELECT rowid, id, title, body FROM notes_normalized WHERE new.rowid = notes_normalized.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_insert AFTER INSERT ON notes_normalized BEGIN INSERT INTO notes_fts(docid, id, title, body) SELECT rowid, id, title, body FROM notes_normalized WHERE new.rowid = notes_normalized.rowid; END;`),
];

export const schemaRevisionsV19 = () => [
	statement(sql`CREATE TABLE revisions (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT "", item_type INT NOT NULL, item_id TEXT NOT NULL, item_updated_time INT NOT NULL, title_diff TEXT NOT NULL DEFAULT "", body_diff TEXT NOT NULL DEFAULT "", metadata_diff TEXT NOT NULL DEFAULT "", encryption_cipher_text TEXT NOT NULL DEFAULT "", encryption_applied INT NOT NULL DEFAULT 0, updated_time INT NOT NULL, created_time INT NOT NULL)`),
	statement(sql`CREATE INDEX revisions_parent_id ON revisions (parent_id)`),
	statement(sql`CREATE INDEX revisions_item_type ON revisions (item_type)`),
	statement(sql`CREATE INDEX revisions_item_id ON revisions (item_id)`),
	statement(sql`CREATE INDEX revisions_item_updated_time ON revisions (item_updated_time)`),
	statement(sql`CREATE INDEX revisions_updated_time ON revisions (updated_time)`),
	statement(sql`ALTER TABLE item_changes ADD COLUMN source INT NOT NULL DEFAULT 1`),
	statement(sql`ALTER TABLE item_changes ADD COLUMN before_change_item TEXT NOT NULL DEFAULT ""`),
];

export const schemaMigrationsV20 = () => [
	statement(sql`CREATE TABLE migrations (id INTEGER PRIMARY KEY, number INTEGER NOT NULL, updated_time INT NOT NULL, created_time INT NOT NULL)`),
	statement(sql`ALTER TABLE resources ADD COLUMN \`size\` INT NOT NULL DEFAULT -1`),
];

export const schemaItemLocationV21 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN item_location INT NOT NULL DEFAULT 1`),
];

export const schemaResourcesToDownloadV22 = () => [
	statement(sql`CREATE TABLE resources_to_download (id INTEGER PRIMARY KEY, resource_id TEXT NOT NULL, updated_time INT NOT NULL, created_time INT NOT NULL)`),
	statement(sql`CREATE INDEX resources_to_download_resource_id ON resources_to_download (resource_id)`),
	statement(sql`CREATE INDEX resources_to_download_updated_time ON resources_to_download (updated_time)`),
];

export const schemaKeyValuesV23 = () => [
	statement(sql`CREATE TABLE key_values (id INTEGER PRIMARY KEY, \`key\` TEXT NOT NULL, \`value\` TEXT NOT NULL, \`type\` INT NOT NULL, updated_time INT NOT NULL)`),
	statement(sql`CREATE UNIQUE INDEX key_values_key ON key_values (key)`),
];

export const schemaMarkupLanguageV24 = () => [
	// 1: Markdown, 2: HTML
	statement(sql`ALTER TABLE notes ADD COLUMN \`markup_language\` INT NOT NULL DEFAULT 1`),
];

export const schemaTagsWithNoteCountV25 = () => [
	statement(sql`CREATE VIEW tags_with_note_count AS
		SELECT tags.id as id, tags.title as title, tags.created_time as created_time, tags.updated_time as updated_time, COUNT(notes.id) as note_count
		FROM tags
			LEFT JOIN note_tags nt on nt.tag_id = tags.id
			LEFT JOIN notes on notes.id = nt.note_id
		WHERE notes.id IS NOT NULL
		GROUP BY tags.id`),
];

export const schemaIsSharedV26 = (table: SchemaBaseItemTable) => statement(sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN is_shared INT NOT NULL DEFAULT 0`);

export const schemaResourcesSizeIndexV28 = () => [
	statement(sql`CREATE INDEX resources_size ON resources(size)`),
];

export const schemaTableFieldsVersionV29 = () => [
	statement(sql`ALTER TABLE version ADD COLUMN table_fields_version INT NOT NULL DEFAULT 0`),
];

export const schemaTagParentIdV31 = () => [
	statement(sql`ALTER TABLE tags ADD COLUMN parent_id TEXT NOT NULL DEFAULT ""`),
];

export const schemaTagsWithNoteCountV32 = () => [
	statement(sql`CREATE VIEW IF NOT EXISTS tags_with_note_count AS
		SELECT tags.id as id, tags.title as title, tags.created_time as created_time, tags.updated_time as updated_time, COUNT(notes.id) as note_count
		FROM tags
			LEFT JOIN note_tags nt on nt.tag_id = tags.id
			LEFT JOIN notes on notes.id = nt.note_id
		WHERE notes.id IS NOT NULL
		GROUP BY tags.id`),
];

export const schemaNotesFtsTriggersDropV33 = () => [
	statement(sql`DROP TRIGGER notes_fts_before_update`),
	statement(sql`DROP TRIGGER notes_fts_before_delete`),
	statement(sql`DROP TRIGGER notes_after_update`),
	statement(sql`DROP TRIGGER notes_after_insert`),
];

export const schemaNotesNormalizedV33 = () => [
	statement(sql`CREATE TABLE notes_normalized (id TEXT NOT NULL, title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "", user_created_time INT NOT NULL DEFAULT 0, user_updated_time INT NOT NULL DEFAULT 0, is_todo INT NOT NULL DEFAULT 0, todo_completed INT NOT NULL DEFAULT 0, parent_id TEXT NOT NULL DEFAULT "", latitude NUMERIC NOT NULL DEFAULT 0, longitude NUMERIC NOT NULL DEFAULT 0, altitude NUMERIC NOT NULL DEFAULT 0, source_url TEXT NOT NULL DEFAULT "")`),
	statement(sql`CREATE INDEX notes_normalized_id ON notes_normalized (id)`),
	statement(sql`CREATE INDEX notes_normalized_user_created_time ON notes_normalized (user_created_time)`),
	statement(sql`CREATE INDEX notes_normalized_user_updated_time ON notes_normalized (user_updated_time)`),
	statement(sql`CREATE INDEX notes_normalized_is_todo ON notes_normalized (is_todo)`),
	statement(sql`CREATE INDEX notes_normalized_todo_completed ON notes_normalized (todo_completed)`),
	statement(sql`CREATE INDEX notes_normalized_parent_id ON notes_normalized (parent_id)`),
	statement(sql`CREATE INDEX notes_normalized_latitude ON notes_normalized (latitude)`),
	statement(sql`CREATE INDEX notes_normalized_longitude ON notes_normalized (longitude)`),
	statement(sql`CREATE INDEX notes_normalized_altitude ON notes_normalized (altitude)`),
	statement(sql`CREATE INDEX notes_normalized_source_url ON notes_normalized (source_url)`),
	statement(sql`CREATE VIRTUAL TABLE notes_fts USING fts4(content="notes_normalized", notindexed="id", notindexed="user_created_time", notindexed="user_updated_time", notindexed="is_todo", notindexed="todo_completed", notindexed="parent_id", notindexed="latitude", notindexed="longitude", notindexed="altitude", notindexed="source_url", id, title, body, user_created_time, user_updated_time, is_todo, todo_completed, parent_id, latitude, longitude, altitude, source_url)`),
	statement(sql`CREATE TRIGGER notes_fts_before_update BEFORE UPDATE ON notes_normalized BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_fts_before_delete BEFORE DELETE ON notes_normalized BEGIN DELETE FROM notes_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_update AFTER UPDATE ON notes_normalized BEGIN INSERT INTO notes_fts(docid, id, title, body, user_created_time, user_updated_time, is_todo, todo_completed, parent_id, latitude, longitude, altitude, source_url) SELECT rowid, id, title, body, user_created_time, user_updated_time, is_todo, todo_completed, parent_id, latitude, longitude, altitude, source_url FROM notes_normalized WHERE new.rowid = notes_normalized.rowid; END;`),
	statement(sql`CREATE TRIGGER notes_after_insert AFTER INSERT ON notes_normalized BEGIN INSERT INTO notes_fts(docid, id, title, body, user_created_time, user_updated_time, is_todo, todo_completed, parent_id, latitude, longitude, altitude, source_url) SELECT rowid, id, title, body, user_created_time, user_updated_time, is_todo, todo_completed, parent_id, latitude, longitude, altitude, source_url FROM notes_normalized WHERE new.rowid = notes_normalized.rowid; END;`),
];

export const schemaSearchAuxAndSpellfixV34 = () => [
	statement(sql`CREATE VIRTUAL TABLE search_aux USING fts4aux(notes_fts)`),
	statement(sql`CREATE VIRTUAL TABLE notes_spellfix USING spellfix1`),
];

export const schemaNotesNormalizedTodoDueV35 = () => [
	statement(sql`ALTER TABLE notes_normalized ADD COLUMN todo_due INT NOT NULL DEFAULT 0`),
	statement(sql`CREATE INDEX notes_normalized_todo_due ON notes_normalized (todo_due)`),
];

export const schemaShareIdV36 = () => [
	statement(sql`ALTER TABLE folders ADD COLUMN share_id TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE notes ADD COLUMN share_id TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE resources ADD COLUMN share_id TEXT NOT NULL DEFAULT ""`),
];

export const schemaTagsWithNoteCountV38 = () => [
	statement(sql`CREATE VIEW tags_with_note_count AS
		SELECT tags.id as id, tags.title as title, tags.created_time as created_time, tags.updated_time as updated_time, COUNT(notes.id) as note_count,
			SUM(CASE WHEN notes.todo_completed > 0 THEN 1 ELSE 0 END) AS todo_completed_count
		FROM tags
			LEFT JOIN note_tags nt on nt.tag_id = tags.id
			LEFT JOIN notes on notes.id = nt.note_id
		WHERE notes.id IS NOT NULL
		GROUP BY tags.id`),
];

export const schemaConflictOriginalIdV39 = () => [
	statement(sql`ALTER TABLE \`notes\` ADD COLUMN conflict_original_id TEXT NOT NULL DEFAULT ""`),
];

export const schemaMasterKeyIdV40 = () => [
	statement(sql`ALTER TABLE \`folders\` ADD COLUMN master_key_id TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`notes\` ADD COLUMN master_key_id TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN master_key_id TEXT NOT NULL DEFAULT ""`),
];

export const schemaFolderIconV41 = () => [
	statement(sql`ALTER TABLE \`folders\` ADD COLUMN icon TEXT NOT NULL DEFAULT ""`),
];

export const schemaUserDataV43 = () => [
	statement(sql`ALTER TABLE \`notes\` ADD COLUMN \`user_data\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`tags\` ADD COLUMN \`user_data\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`folders\` ADD COLUMN \`user_data\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`user_data\` TEXT NOT NULL DEFAULT ""`),
];

export const schemaBlobUpdatedTimeV44 = () => [
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN blob_updated_time INT NOT NULL DEFAULT 0`),
];

export const schemaOcrAndItemsFtsV45 = () => [
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`ocr_text\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`ocr_details\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`ocr_status\` INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`ocr_error\` TEXT NOT NULL DEFAULT ""`),
	statement(sql`CREATE TABLE items_normalized (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "", item_id TEXT NOT NULL, item_type INT NOT NULL, user_updated_time INT NOT NULL DEFAULT 0, reserved1 INT NULL, reserved2 INT NULL, reserved3 INT NULL, reserved4 INT NULL, reserved5 INT NULL, reserved6 INT NULL)`),
	statement(sql`CREATE INDEX items_normalized_id ON items_normalized (id)`),
	statement(sql`CREATE INDEX items_normalized_item_id ON items_normalized (item_id)`),
	statement(sql`CREATE INDEX items_normalized_item_type ON items_normalized (item_type)`),
	statement(sql`CREATE VIRTUAL TABLE items_fts USING fts4(content="items_normalized", notindexed="id", notindexed="item_id", notindexed="item_type", notindexed="user_updated_time", notindexed="reserved1", notindexed="reserved2", notindexed="reserved3", notindexed="reserved4", notindexed="reserved5", notindexed="reserved6", id, title, body, item_id, item_type, user_updated_time, reserved1, reserved2, reserved3, reserved4, reserved5, reserved6)`),
	statement(sql`CREATE TRIGGER items_fts_before_update BEFORE UPDATE ON items_normalized BEGIN DELETE FROM items_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER items_fts_before_delete BEFORE DELETE ON items_normalized BEGIN DELETE FROM items_fts WHERE docid=old.rowid; END;`),
	statement(sql`CREATE TRIGGER items_after_update AFTER UPDATE ON items_normalized BEGIN INSERT INTO items_fts(docid, id, title, body, item_id, item_type, user_updated_time, reserved1, reserved2, reserved3, reserved4, reserved5, reserved6) SELECT rowid, id, title, body, item_id, item_type, user_updated_time, reserved1, reserved2, reserved3, reserved4, reserved5, reserved6 FROM items_normalized WHERE new.rowid = items_normalized.rowid; END;`),
	statement(sql`CREATE TRIGGER items_after_insert AFTER INSERT ON items_normalized BEGIN INSERT INTO items_fts(docid, id, title, body, item_id, item_type, user_updated_time, reserved1, reserved2, reserved3, reserved4, reserved5, reserved6) SELECT rowid, id, title, body, item_id, item_type, user_updated_time, reserved1, reserved2, reserved3, reserved4, reserved5, reserved6 FROM items_normalized WHERE new.rowid = items_normalized.rowid; END;`),
];

export const schemaDeletedTimeV46 = () => [
	statement(sql`ALTER TABLE \`notes\` ADD COLUMN \`deleted_time\` INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE \`folders\` ADD COLUMN \`deleted_time\` INT NOT NULL DEFAULT 0`),
];

export const schemaTagsWithNoteCountV46 = () => [
	statement(sql`
			CREATE VIEW tags_with_note_count AS
			SELECT
				tags.id as id,
				tags.title as title,
				tags.created_time as created_time,
				tags.updated_time as updated_time,
				COUNT(notes.id) as note_count,
				SUM(CASE WHEN notes.todo_completed > 0 THEN 1 ELSE 0 END) AS todo_completed_count
			FROM tags
				LEFT JOIN note_tags nt on nt.tag_id = tags.id
				LEFT JOIN notes on notes.id = nt.note_id
			WHERE
				notes.id IS NOT NULL
				AND notes.deleted_time = 0
			GROUP BY tags.id
		`),
];

export const schemaSyncWarningIgnoredV47 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN sync_warning_ignored INT NOT NULL DEFAULT "0"`),
];

export const schemaOcrDriverIdV48 = () => [
	statement(sql`ALTER TABLE \`resources\` ADD COLUMN \`ocr_driver_id\` INT NOT NULL DEFAULT "1"`),
];

export const schemaRemoteItemUpdatedTimeV49 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN remote_item_updated_time INT NOT NULL DEFAULT 0`),
];

export const schemaIsLockedV50 = () => [
	statement(sql`ALTER TABLE notes ADD COLUMN is_locked INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE notes ADD COLUMN extracted_resource_ids TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE revisions ADD COLUMN is_locked INT NOT NULL DEFAULT 0`),
	statement(sql`ALTER TABLE resources ADD COLUMN is_locked INT NOT NULL DEFAULT 0`),
];

export const schemaConflictStateV51 = () => [
	statement(sql`ALTER TABLE sync_items ADD COLUMN base_body TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE sync_items ADD COLUMN base_title TEXT NOT NULL DEFAULT ""`),
	statement(sql`ALTER TABLE sync_items ADD COLUMN base_conflict_note_id TEXT NOT NULL DEFAULT ""`),
	statement(sql`CREATE TABLE IF NOT EXISTS conflict_note_states (
			note_id TEXT PRIMARY KEY,
			base_body TEXT NOT NULL DEFAULT "",
			base_title TEXT NOT NULL DEFAULT "",
			remote_body TEXT NOT NULL DEFAULT "",
			remote_title TEXT NOT NULL DEFAULT "",
			remote_updated_time INT NOT NULL DEFAULT 0
		)`),
];

export const schemaNoteEmbeddingsMetaV52 = () => [
	statement(sql`CREATE TABLE IF NOT EXISTS note_embeddings_meta (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			model_id TEXT NOT NULL,
			chunk_text TEXT NOT NULL,
			created_time INT NOT NULL DEFAULT 0
		)`),
	statement(sql`CREATE INDEX IF NOT EXISTS note_embeddings_meta_note_id ON note_embeddings_meta(note_id)`),
	statement(sql`CREATE UNIQUE INDEX IF NOT EXISTS note_embeddings_meta_note_chunk ON note_embeddings_meta(note_id, chunk_index)`),
];

export const schemaConflictNoteStatesV53 = () => [
	statement(sql`CREATE TABLE conflict_note_states (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id TEXT NOT NULL UNIQUE,
			base_body TEXT NOT NULL DEFAULT "",
			base_title TEXT NOT NULL DEFAULT "",
			remote_body TEXT NOT NULL DEFAULT "",
			remote_title TEXT NOT NULL DEFAULT "",
			remote_updated_time INT NOT NULL DEFAULT 0
		)`),
];
