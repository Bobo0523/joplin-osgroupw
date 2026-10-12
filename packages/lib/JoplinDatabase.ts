import Resource from './models/Resource';
import shim from './shim';
import Database, { QueryInput, Row } from './database';
import addMigrationFile from './services/database/addMigrationFile';
import migrations from './services/database/migrations';
import { dynamicKysely, insertInto, kysely } from './services/database/kysely';
import { addColumnQuery, alterColumnQueries, column, createIndexQuery, createTableQuery, intColumn, textColumn } from './services/database/schemaUtils';
import createTagsWithNoteCountView from './services/database/tagsWithNoteCountView';
import { createFtsTableQuery, createFtsTriggerQueries, createVirtualTableQuery, dropTriggerQuery, ftsInitialIndexQuery, tableInfoQuery } from './services/database/sqlFragments';

const { sprintf } = require('sprintf-js');

const notesFtsTriggerNames = ['notes_fts_before_update', 'notes_fts_before_delete', 'notes_after_update', 'notes_after_insert'] as const;

// In SQLite, if the default value of a column is a string, PRAGMA table_info
// returns it with quotes around it, so they are removed here. The original
// upgrade steps used double quotes and the Kysely schema builder uses single
// quotes, in which case a quote inside the string is doubled.
export const unquoteDefaultValue = (defaultValue: unknown) => {
	if (typeof defaultValue !== 'string' || defaultValue.length < 2) return defaultValue;
	const quote = defaultValue[0];
	if (defaultValue[defaultValue.length - 1] !== quote) return defaultValue;
	if (quote === '"') return defaultValue.substr(1, defaultValue.length - 2);
	if (quote === '\'') return defaultValue.substr(1, defaultValue.length - 2).replace(/''/g, '\'');
	return defaultValue;
};

// The schema of version 1 of the database. The tables were changed later on
// by the upgrade steps in upgradeDatabase().
const structureQueries = () => {
	const timestamps = [column('created_time', 'int', { notNull: true }), column('updated_time', 'int', { notNull: true })];

	return [
		createTableQuery('folders', [
			column('id', 'text', { primaryKey: true }),
			textColumn('title'),
			...timestamps,
		]),
		createIndexQuery('folders_title', 'folders', ['title']),
		createIndexQuery('folders_updated_time', 'folders', ['updated_time']),

		createTableQuery('notes', [
			column('id', 'text', { primaryKey: true }),
			textColumn('parent_id'),
			textColumn('title'),
			textColumn('body'),
			...timestamps,
			intColumn('is_conflict'),
			column('latitude', 'numeric', { notNull: true, default: 0 }),
			column('longitude', 'numeric', { notNull: true, default: 0 }),
			column('altitude', 'numeric', { notNull: true, default: 0 }),
			textColumn('author'),
			textColumn('source_url'),
			intColumn('is_todo'),
			intColumn('todo_due'),
			intColumn('todo_completed'),
			textColumn('source'),
			textColumn('source_application'),
			textColumn('application_data'),
			intColumn('order'),
		]),
		createIndexQuery('notes_title', 'notes', ['title']),
		createIndexQuery('notes_updated_time', 'notes', ['updated_time']),
		createIndexQuery('notes_is_conflict', 'notes', ['is_conflict']),
		createIndexQuery('notes_is_todo', 'notes', ['is_todo']),
		createIndexQuery('notes_order', 'notes', ['order']),

		createTableQuery('tags', [
			column('id', 'text', { primaryKey: true }),
			textColumn('title'),
			...timestamps,
		]),
		createIndexQuery('tags_title', 'tags', ['title']),
		createIndexQuery('tags_updated_time', 'tags', ['updated_time']),

		createTableQuery('note_tags', [
			column('id', 'text', { primaryKey: true }),
			column('note_id', 'text', { notNull: true }),
			column('tag_id', 'text', { notNull: true }),
			...timestamps,
		]),
		createIndexQuery('note_tags_note_id', 'note_tags', ['note_id']),
		createIndexQuery('note_tags_tag_id', 'note_tags', ['tag_id']),
		createIndexQuery('note_tags_updated_time', 'note_tags', ['updated_time']),

		createTableQuery('resources', [
			column('id', 'text', { primaryKey: true }),
			textColumn('title'),
			column('mime', 'text', { notNull: true }),
			textColumn('filename'),
			...timestamps,
		]),
		createIndexQuery('resources_title', 'resources', ['title']),
		createIndexQuery('resources_updated_time', 'resources', ['updated_time']),

		createTableQuery('settings', [
			column('key', 'text', { primaryKey: true }),
			column('value', 'text'),
			column('type', 'int', { notNull: true }),
		]),

		createTableQuery('table_fields', [
			column('id', 'integer', { primaryKey: true }),
			column('table_name', 'text', { notNull: true }),
			column('field_name', 'text', { notNull: true }),
			column('field_type', 'int', { notNull: true }),
			column('field_default', 'text'),
		]),

		createTableQuery('sync_items', [
			column('id', 'integer', { primaryKey: true }),
			column('sync_target', 'int', { notNull: true }),
			intColumn('sync_time'),
			column('item_type', 'int', { notNull: true }),
			column('item_id', 'text', { notNull: true }),
		]),
		createIndexQuery('sync_items_sync_time', 'sync_items', ['sync_time']),
		createIndexQuery('sync_items_sync_target', 'sync_items', ['sync_target']),
		createIndexQuery('sync_items_item_type', 'sync_items', ['item_type']),
		createIndexQuery('sync_items_item_id', 'sync_items', ['item_id']),

		createTableQuery('deleted_items', [
			column('id', 'integer', { primaryKey: true }),
			column('item_type', 'int', { notNull: true }),
			column('item_id', 'text', { notNull: true }),
			column('deleted_time', 'int', { notNull: true }),
		]),

		createTableQuery('version', [
			column('version', 'int', { notNull: true }),
		]),

		insertInto('version', { version: 1 }),
	];
};

export interface TableField {
	name: string;
	type: number;
	default?: string | number | boolean | null;
	description?: string;
}

export default class JoplinDatabase extends Database {

	public static TYPE_INT = 1;
	public static TYPE_TEXT = 2;
	public static TYPE_NUMERIC = 3;

	private initialized_ = false;
	private tableFields_: Record<string, TableField[]> = null;
	private version_: number = null;
	private tableFieldNames_: Record<string, string[]> = {};
	private tableDescriptions_: Record<string, Record<string, string>>;
	private sqliteVecAvailable_ = false;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Base Database class uses `any` for driver — different drivers (sqlite, better-sqlite3, web) have different shapes
	public constructor(driver: any) {
		super(driver);
	}

	public initialized() {
		return this.initialized_;
	}

	// Returns true if the sqlite-vec extension loaded successfully when the
	// database was opened. False on platforms where the prebuilt is missing or
	// extension loading is otherwise blocked. Callers that need vector search
	// (the AI embeddings index) should gate on this and degrade gracefully
	// rather than throwing.
	public sqliteVecAvailable() {
		return this.sqliteVecAvailable_;
	}

	public async open(options: Record<string, unknown>) {
		await super.open(options);
		await this.tryLoadSqliteVec();
		return this.initialize();
	}

	private async tryLoadSqliteVec() {
		const sqliteVec = shim.sqliteVec();
		if (!sqliteVec) {
			this.sqliteVecAvailable_ = false;
			this.logger().info('sqlite-vec not provided by the host app; vector search disabled');
			return;
		}
		try {
			await this.loadExtension(sqliteVec.getLoadablePath());
			this.sqliteVecAvailable_ = true;
			this.logger().info('sqlite-vec extension loaded');
		} catch (error) {
			this.sqliteVecAvailable_ = false;
			this.logger().warn('sqlite-vec extension failed to load; vector search disabled:', error);
		}
	}

	public tableFieldNames(tableName: string) {
		if (this.tableFieldNames_[tableName]) return this.tableFieldNames_[tableName].slice();

		const tf = this.tableFields(tableName);
		const output = [];
		for (let i = 0; i < tf.length; i++) {
			output.push(tf[i].name);
		}
		this.tableFieldNames_[tableName] = output;

		return output.slice();
	}

	public tableFields(tableName: string, options: { includeDescription?: boolean } = null) {
		if (options === null) options = {};

		if (!this.tableFields_) throw new Error('Fields have not been loaded yet');
		if (!this.tableFields_[tableName]) throw new Error(`Unknown table: ${tableName}`);
		const output = this.tableFields_[tableName].slice();

		if (options.includeDescription) {
			for (let i = 0; i < output.length; i++) {
				output[i].description = this.fieldDescription(tableName, output[i].name);
			}
		}

		return output;
	}

	public async clearForTesting() {
		const tableNames = [
			'notes',
			'folders',
			'resources',
			'tags',
			'note_tags',
			// 'master_keys',
			'item_changes',
			'note_resources',
			// 'settings',
			'deleted_items',
			'sync_items',
			'notes_normalized',
			'revisions',
			'resources_to_download',
			'key_values',
		];

		const queries: QueryInput[] = [];
		for (const n of tableNames) {
			queries.push(dynamicKysely.deleteFrom(n));
			queries.push(kysely.deleteFrom('sqlite_sequence').where('name', '=', n)); // Reset autoincremented IDs
		}

		const settingKeys = [
			'sync.1.context',
			'sync.2.context',
			'sync.3.context',
			'sync.4.context',
			'sync.5.context',
			'sync.6.context',
			'sync.7.context',
			'revisionService.lastProcessedChangeId',
			'resourceService.lastProcessedChangeId',
			'searchEngine.lastProcessedChangeId',
		];
		for (const key of settingKeys) queries.push(kysely.deleteFrom('settings').where('key', '=', key));

		await this.transactionExecBatch(queries);
	}

	public createDefaultRow(tableName: string) {
		const row: Record<string, unknown> = {};
		const fields = this.tableFields(tableName);
		for (let i = 0; i < fields.length; i++) {
			const f = fields[i];
			row[f.name] = Database.formatValue(f.type, f.default);
		}
		return row;
	}

	public fieldByName(tableName: string, fieldName: string) {
		const fields = this.tableFields(tableName);
		for (const field of fields) {
			if (field.name === fieldName) return field;
		}
		throw new Error(`No such field: ${tableName}: ${fieldName}`);
	}

	public fieldDefaultValue(tableName: string, fieldName: string) {
		return this.fieldByName(tableName, fieldName).default;
	}

	public fieldDescription(tableName: string, fieldName: string) {
		const sp = sprintf;

		if (!this.tableDescriptions_) {
			this.tableDescriptions_ = {
				notes: {
					parent_id: sp('ID of the notebook that contains this note. Change this ID to move the note to a different notebook.'),
					body: sp('The note body, in Markdown. May also contain HTML.'),
					is_conflict: sp('Tells whether the note is a conflict or not.'),
					is_todo: sp('Tells whether this note is a todo or not.'),
					todo_due: sp('When the todo is due. An alarm will be triggered on that date.'),
					todo_completed: sp('Tells whether todo is completed or not. This is a timestamp in milliseconds.'),
					source_url: sp('The full URL where the note comes from.'),
					is_shared: sp('Whether the note is published.'),
				},
				folders: {},
				resources: {},
				tags: {},
				item_changes: {
					type: 'The type of change - either 1 (created), 2 (updated) or 3 (deleted)',
					created_time: 'When the event was generated',
					item_type: 'The item type (see table above for the list of item types)',
					item_id: 'The item ID',
					before_change_item: 'Unused',
					source: 'Unused',
				},
			};

			const baseItems = ['notes', 'folders', 'tags', 'resources'];

			for (let i = 0; i < baseItems.length; i++) {
				const n = baseItems[i];
				const singular = n.substr(0, n.length - 1);
				this.tableDescriptions_[n].title = sp('The %s title.', singular);
				this.tableDescriptions_[n].created_time = sp('When the %s was created.', singular);
				this.tableDescriptions_[n].updated_time = sp('When the %s was last updated.', singular);
				this.tableDescriptions_[n].user_created_time = sp('When the %s was created. It may differ from created_time as it can be manually set by the user.', singular);
				this.tableDescriptions_[n].user_updated_time = sp('When the %s was last updated. It may differ from updated_time as it can be manually set by the user.', singular);
				this.tableDescriptions_[n].share_id = sp('The ID of the Joplin Server/Cloud share containing the %s. Empty if not shared.', singular);
			}
		}

		const d = this.tableDescriptions_[tableName];
		return d && d[fieldName] ? d[fieldName] : '';
	}

	private async countFields(tableName: string): Promise<number> {
		const pragmas = await this.selectAll(tableInfoQuery(tableName));
		if (!pragmas) throw new Error(`No such table: ${tableName}`);
		return pragmas.length;
	}

	public async refreshTableFields(newVersion: number) {
		this.logger().info('Initializing tables...');
		const queries: QueryInput[] = [];
		queries.push(kysely.deleteFrom('table_fields'));

		const countFieldsNotesFts = await this.countFields('notes_fts');
		const countFieldsItemsFts = await this.countFields('items_fts');
		if (countFieldsNotesFts !== countFieldsItemsFts) {
			throw new Error(`\`notes_fts\` (${countFieldsNotesFts} fields) must have the same number of fields as \`items_fts\` (${countFieldsItemsFts} fields) for the search engine BM25 algorithm to work`);
		}

		interface TableRow {
			name: string;
		}

		const tableRows: TableRow[] = await this.selectAll(kysely.selectFrom('sqlite_master').select('name').where('type', '=', 'table'));

		for (let i = 0; i < tableRows.length; i++) {
			let pragmas: Row[] = [];
			const tableName = tableRows[i].name;
			try {
				if (tableName === 'android_metadata') continue;
				if (tableName === 'table_fields') continue;
				if (tableName.startsWith('sqlite_')) continue;
				if (tableName.indexOf('notes_fts') === 0) continue;
				if (tableName.indexOf('items_fts') === 0) continue;
				if (tableName === 'notes_spellfix') continue;
				if (tableName === 'search_aux') continue;
				if (tableName.startsWith('note_embeddings_vec')) continue;

				pragmas = await this.selectAll(tableInfoQuery(tableName));

				for (let i = 0; i < pragmas.length; i++) {
					const item = pragmas[i];
					const defaultValue = unquoteDefaultValue(item.dflt_value);
					const q = Database.insertQuery('table_fields', {
						table_name: tableName,
						field_name: item.name,
						field_type: Database.enumId('fieldType', item.type),
						field_default: defaultValue,
					});
					queries.push(q);
				}
			} catch (error) {
				error.message = `On table: ${tableName}: Pragma: ${JSON.stringify(pragmas)}: ${error.message}`;
				throw error;
			}
		}

		queries.push(kysely.updateTable('version').set({ table_fields_version: newVersion }));
		await this.transactionExecBatch(queries);
	}

	public async upgradeDatabase(fromVersion: number) {
		// INSTRUCTIONS TO UPGRADE THE DATABASE:
		//
		// 1. Add the migration to lib/services/database/migrations.
		// 2. Import the migration and add it to the `migrations` array above.

		// IMPORTANT:
		//
		// Whenever adding a new database property, some additional logic might be needed
		// in the synchronizer to handle this property. For example, when adding a property
		// that should have a default value, existing remote items will not have this
		// default value and thus might cause problems. In that case, the default value
		// must be set in the synchronizer too.

		// Note: v16 and v17 don't do anything. They were used to debug an issue.
		const existingDatabaseVersions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41];

		for (let i = 0; i < migrations.length; i++) existingDatabaseVersions.push(existingDatabaseVersions[existingDatabaseVersions.length - 1] + 1);

		let currentVersionIndex = existingDatabaseVersions.indexOf(fromVersion);

		// currentVersionIndex < 0 if for the case where an old version of Joplin used with a newer
		// version of the database, so that migration is not run in this case.
		if (currentVersionIndex < 0) {
			throw new Error(
				'Unknown profile version. Most likely this is an old version of Joplin, while the profile was created by a newer version. Please upgrade Joplin at https://joplinapp.org and try again.\n'
				+ `Joplin version: ${shim.appVersion()}\n`
				+ `Profile version: ${fromVersion}\n`
				+ `Expected version: ${existingDatabaseVersions[existingDatabaseVersions.length - 1]}`);
		}

		this.logger().info(`Upgrading database from version ${fromVersion}`);

		if (currentVersionIndex === existingDatabaseVersions.length - 1) return fromVersion;

		let latestVersion = fromVersion;

		while (currentVersionIndex < existingDatabaseVersions.length - 1) {
			const targetVersion = existingDatabaseVersions[currentVersionIndex + 1];
			this.logger().info(`Converting database to version ${targetVersion}`);

			let queries: QueryInput[] = [];

			if (targetVersion === 1) {
				queries = structureQueries();
			}

			if (targetVersion === 2) {
				queries.push(kysely.schema.dropTable('deleted_items'));
				queries.push(createTableQuery('deleted_items', [
					column('id', 'integer', { primaryKey: true }),
					column('item_type', 'int', { notNull: true }),
					column('item_id', 'text', { notNull: true }),
					column('deleted_time', 'int', { notNull: true }),
					column('sync_target', 'int', { notNull: true }),
				]));
				queries.push(createIndexQuery('deleted_items_sync_target', 'deleted_items', ['sync_target']));
			}

			if (targetVersion === 3) {
				queries = alterColumnQueries('settings', [column('key', 'text', { primaryKey: true }), column('value', 'text')]);
			}

			if (targetVersion === 4) {
				queries.push(insertInto('settings', { key: 'sync.3.context', value: kysely.selectFrom('settings').select('value').where('key', '=', 'sync.context') }));
				queries.push(kysely.deleteFrom('settings').where('key', '=', 'sync.context'));
			}

			if (targetVersion === 5) {
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumnQuery(n, intColumn('user_created_time')));
					queries.push(addColumnQuery(n, intColumn('user_updated_time')));
					queries.push(dynamicKysely.updateTable(n).set(eb => ({ user_created_time: eb.ref('created_time') })));
					queries.push(dynamicKysely.updateTable(n).set(eb => ({ user_updated_time: eb.ref('updated_time') })));
					queries.push(createIndexQuery(`${n}_user_updated_time`, n, ['user_updated_time']));
				}
			}

			if (targetVersion === 6) {
				queries.push(createTableQuery('alarms', [
					column('id', 'integer', { primaryKey: true, autoIncrement: true }),
					column('note_id', 'text', { notNull: true }),
					column('trigger_time', 'int', { notNull: true }),
				]));
				queries.push(createIndexQuery('alarm_note_id', 'alarms', ['note_id']));
			}

			if (targetVersion === 7) {
				queries.push(addColumnQuery('resources', textColumn('file_extension')));
			}

			if (targetVersion === 8) {
				queries.push(addColumnQuery('sync_items', intColumn('sync_disabled', '0')));
				queries.push(addColumnQuery('sync_items', textColumn('sync_disabled_reason')));
			}

			if (targetVersion === 9) {
				queries.push(createTableQuery('master_keys', [
					column('id', 'text', { primaryKey: true }),
					column('created_time', 'int', { notNull: true }),
					column('updated_time', 'int', { notNull: true }),
					column('source_application', 'text', { notNull: true }),
					column('encryption_method', 'int', { notNull: true }),
					column('checksum', 'text', { notNull: true }),
					column('content', 'text', { notNull: true }),
				]));
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumnQuery(n, textColumn('encryption_cipher_text')));
					queries.push(addColumnQuery(n, intColumn('encryption_applied')));
					queries.push(createIndexQuery(`${n}_encryption_applied`, n, ['encryption_applied']));
				}

				queries.push(addColumnQuery('sync_items', intColumn('force_sync')));
				queries.push(addColumnQuery('resources', intColumn('encryption_blob_encrypted')));
			}

			const upgradeVersion10 = () => {
				queries.push(createTableQuery('item_changes', [
					column('id', 'integer', { primaryKey: true, autoIncrement: true }),
					column('item_type', 'int', { notNull: true }),
					column('item_id', 'text', { notNull: true }),
					column('type', 'int', { notNull: true }),
					column('created_time', 'int', { notNull: true }),
				]));
				queries.push(createIndexQuery('item_changes_item_id', 'item_changes', ['item_id']));
				queries.push(createIndexQuery('item_changes_created_time', 'item_changes', ['created_time']));
				queries.push(createIndexQuery('item_changes_item_type', 'item_changes', ['item_type']));

				queries.push(createTableQuery('note_resources', [
					column('id', 'integer', { primaryKey: true }),
					column('note_id', 'text', { notNull: true }),
					column('resource_id', 'text', { notNull: true }),
					column('is_associated', 'int', { notNull: true }),
					column('last_seen_time', 'int', { notNull: true }),
				]));
				queries.push(createIndexQuery('note_resources_note_id', 'note_resources', ['note_id']));
				queries.push(createIndexQuery('note_resources_resource_id', 'note_resources', ['resource_id']));

				queries.push(kysely.insertInto('item_changes')
					.columns(['item_type', 'item_id', 'type', 'created_time'])
					.expression(kysely.selectFrom('notes').select(eb => [eb.lit(1).as('item_type'), 'id', eb.lit(1).as('type'), eb.val(Date.now()).as('created_time')])));
			};

			if (targetVersion === 10) {
				upgradeVersion10();
			}

			if (targetVersion === 11) {
				// This trick was needed because Electron Builder incorrectly released a dev branch containing v10 as it was
				// still being developed, and the db schema was not final at that time. So this v11 was created to
				// make sure any invalid db schema that was accidentally created was deleted and recreated.
				queries.push(kysely.schema.dropTable('item_changes'));
				queries.push(kysely.schema.dropTable('note_resources'));
				upgradeVersion10();
			}

			if (targetVersion === 12) {
				queries.push(addColumnQuery('folders', textColumn('parent_id')));
			}

			if (targetVersion === 13) {
				queries.push(addColumnQuery('resources', intColumn('fetch_status', '2')));
				queries.push(addColumnQuery('resources', textColumn('fetch_error')));
				queries.push(dynamicKysely.updateTable('resources').set({ fetch_status: Resource.FETCH_STATUS_DONE }));
			}

			if (targetVersion === 14) {
				queries.push(createTableQuery('resource_local_states', [
					column('id', 'integer', { primaryKey: true }),
					column('resource_id', 'text', { notNull: true }),
					intColumn('fetch_status', '2'),
					textColumn('fetch_error'),
				]));

				queries.push(kysely.insertInto('resource_local_states').expression(
					dynamicKysely.selectFrom('resources').select(eb => [eb.lit(null).as('id'), 'id as resource_id', 'fetch_status', 'fetch_error']),
				));

				queries.push(createIndexQuery('resource_local_states_resource_id', 'resource_local_states', ['resource_id']));
				queries.push(createIndexQuery('resource_local_states_resource_fetch_status', 'resource_local_states', ['fetch_status']));

				queries = queries.concat(
					alterColumnQueries('resources', [
						column('id', 'text', { primaryKey: true }),
						textColumn('title'),
						column('mime', 'text', { notNull: true }),
						textColumn('filename'),
						column('created_time', 'int', { notNull: true }),
						column('updated_time', 'int', { notNull: true }),
						intColumn('user_created_time'),
						intColumn('user_updated_time'),
						textColumn('file_extension'),
						textColumn('encryption_cipher_text'),
						intColumn('encryption_applied'),
						intColumn('encryption_blob_encrypted'),
					]),
				);
			}

			if (targetVersion === 15) {
				const columnNames = ['id', 'title', 'body'];
				queries.push(createFtsTableQuery('notes_fts', ['content="notes"', 'notindexed="id"'], columnNames));
				queries.push(ftsInitialIndexQuery('notes_fts', 'notes', columnNames, 'is_conflict = 0 AND encryption_applied = 0'));

				// Keep the content tables (notes) and the FTS table (notes_fts) in sync.
				queries = queries.concat(createFtsTriggerQueries({
					ftsTableName: 'notes_fts',
					contentTableName: 'notes',
					columnNames,
					triggerNames: notesFtsTriggerNames,
					indexCondition: 'is_conflict = 0 AND encryption_applied = 0',
				}));
			}

			if (targetVersion === 18) {
				queries.push(createTableQuery('notes_normalized', [
					column('id', 'text', { notNull: true }),
					textColumn('title'),
					textColumn('body'),
				]));

				queries.push(createIndexQuery('notes_normalized_id', 'notes_normalized', ['id']));

				for (const triggerName of notesFtsTriggerNames) queries.push(dropTriggerQuery(triggerName, true));
				queries.push(kysely.schema.dropTable('notes_fts').ifExists());

				const columnNames = ['id', 'title', 'body'];
				queries.push(createFtsTableQuery('notes_fts', ['content="notes_normalized"', 'notindexed="id"'], columnNames));

				// Keep the content tables (notes) and the FTS table (notes_fts) in sync.
				queries = queries.concat(createFtsTriggerQueries({
					ftsTableName: 'notes_fts',
					contentTableName: 'notes_normalized',
					columnNames,
					triggerNames: notesFtsTriggerNames,
				}));
			}

			if (targetVersion === 19) {
				queries.push(createTableQuery('revisions', [
					column('id', 'text', { primaryKey: true }),
					textColumn('parent_id'),
					column('item_type', 'int', { notNull: true }),
					column('item_id', 'text', { notNull: true }),
					column('item_updated_time', 'int', { notNull: true }),
					textColumn('title_diff'),
					textColumn('body_diff'),
					textColumn('metadata_diff'),
					textColumn('encryption_cipher_text'),
					intColumn('encryption_applied'),
					column('updated_time', 'int', { notNull: true }),
					column('created_time', 'int', { notNull: true }),
				]));

				queries.push(createIndexQuery('revisions_parent_id', 'revisions', ['parent_id']));
				queries.push(createIndexQuery('revisions_item_type', 'revisions', ['item_type']));
				queries.push(createIndexQuery('revisions_item_id', 'revisions', ['item_id']));
				queries.push(createIndexQuery('revisions_item_updated_time', 'revisions', ['item_updated_time']));
				queries.push(createIndexQuery('revisions_updated_time', 'revisions', ['updated_time']));

				queries.push(addColumnQuery('item_changes', intColumn('source', 1)));
				queries.push(addColumnQuery('item_changes', textColumn('before_change_item')));
			}

			if (targetVersion === 20) {
				queries.push(createTableQuery('migrations', [
					column('id', 'integer', { primaryKey: true }),
					column('number', 'integer', { notNull: true }),
					column('updated_time', 'int', { notNull: true }),
					column('created_time', 'int', { notNull: true }),
				]));

				queries.push(addColumnQuery('resources', intColumn('size', -1)));
				queries.push(addMigrationFile(20));
			}

			if (targetVersion === 21) {
				queries.push(addColumnQuery('sync_items', intColumn('item_location', 1)));
			}

			if (targetVersion === 22) {
				queries.push(createTableQuery('resources_to_download', [
					column('id', 'integer', { primaryKey: true }),
					column('resource_id', 'text', { notNull: true }),
					column('updated_time', 'int', { notNull: true }),
					column('created_time', 'int', { notNull: true }),
				]));

				queries.push(createIndexQuery('resources_to_download_resource_id', 'resources_to_download', ['resource_id']));
				queries.push(createIndexQuery('resources_to_download_updated_time', 'resources_to_download', ['updated_time']));
			}

			if (targetVersion === 23) {
				queries.push(createTableQuery('key_values', [
					column('id', 'integer', { primaryKey: true }),
					column('key', 'text', { notNull: true }),
					column('value', 'text', { notNull: true }),
					column('type', 'int', { notNull: true }),
					column('updated_time', 'int', { notNull: true }),
				]));

				queries.push(createIndexQuery('key_values_key', 'key_values', ['key'], { unique: true }));
			}

			if (targetVersion === 24) {
				queries.push(addColumnQuery('notes', intColumn('markup_language', 1))); // 1: Markdown, 2: HTML
			}

			if (targetVersion === 25) {
				queries.push(createTagsWithNoteCountView({ todoCompletedCount: false, excludeDeletedNotes: false }));
			}

			if (targetVersion === 26) {
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumnQuery(n, intColumn('is_shared')));
				}
			}

			if (targetVersion === 27) {
				queries.push(addMigrationFile(27));
			}

			if (targetVersion === 28) {
				queries.push(createIndexQuery('resources_size', 'resources', ['size']));
			}

			if (targetVersion === 29) {
				queries.push(addColumnQuery('version', intColumn('table_fields_version')));
			}

			if (targetVersion === 30) {
				// Change the type of the "order" field from INT to NUMERIC
				// Making it a float provides a much bigger range when inserting notes.
				// For example, with an INT, inserting a note C between note A with order 1000 and
				// note B with order 1001 wouldn't be possible without changing the order
				// value of note A or B. But with a float, we can set the order of note C to 1000.5
				queries = queries.concat(
					alterColumnQueries('notes', [
						column('id', 'text', { primaryKey: true }),
						textColumn('parent_id'),
						textColumn('title'),
						textColumn('body'),
						column('created_time', 'int', { notNull: true }),
						column('updated_time', 'int', { notNull: true }),
						intColumn('is_conflict'),
						column('latitude', 'numeric', { notNull: true, default: 0 }),
						column('longitude', 'numeric', { notNull: true, default: 0 }),
						column('altitude', 'numeric', { notNull: true, default: 0 }),
						textColumn('author'),
						textColumn('source_url'),
						intColumn('is_todo'),
						intColumn('todo_due'),
						intColumn('todo_completed'),
						textColumn('source'),
						textColumn('source_application'),
						textColumn('application_data'),
						column('order', 'numeric', { notNull: true, default: 0 }), // that's the change!
						intColumn('user_created_time'),
						intColumn('user_updated_time'),
						textColumn('encryption_cipher_text'),
						intColumn('encryption_applied'),
						intColumn('markup_language', 1),
						intColumn('is_shared'),
					]),
				);
			}

			if (targetVersion === 31) {
				// This empty version is due to the revert of the hierarchical tag feature
				// We need to keep the version for the users who have upgraded using
				// the pre-release
				queries.push(addColumnQuery('tags', textColumn('parent_id')));
				// Drop the tag note count view, instead compute note count on the fly
				// queries.push('DROP VIEW tags_with_note_count');
				// queries.push(addMigrationFile(31));
			}

			if (targetVersion === 32) {
				// This is the same as version 25 - this is to complete the
				// revert of the hierarchical tag feature.
				queries.push(createTagsWithNoteCountView({ todoCompletedCount: false, excludeDeletedNotes: false, ifNotExists: true }));
			}

			if (targetVersion === 33) {
				for (const triggerName of notesFtsTriggerNames) queries.push(dropTriggerQuery(triggerName));

				queries.push(kysely.schema.dropIndex('notes_normalized_id'));
				queries.push(kysely.schema.dropTable('notes_normalized'));
				queries.push(kysely.schema.dropTable('notes_fts'));

				queries.push(createTableQuery('notes_normalized', [
					column('id', 'text', { notNull: true }),
					textColumn('title'),
					textColumn('body'),
					intColumn('user_created_time'),
					intColumn('user_updated_time'),
					intColumn('is_todo'),
					intColumn('todo_completed'),
					textColumn('parent_id'),
					column('latitude', 'numeric', { notNull: true, default: 0 }),
					column('longitude', 'numeric', { notNull: true, default: 0 }),
					column('altitude', 'numeric', { notNull: true, default: 0 }),
					textColumn('source_url'),
				]));

				queries.push(createIndexQuery('notes_normalized_id', 'notes_normalized', ['id']));

				queries.push(createIndexQuery('notes_normalized_user_created_time', 'notes_normalized', ['user_created_time']));
				queries.push(createIndexQuery('notes_normalized_user_updated_time', 'notes_normalized', ['user_updated_time']));
				queries.push(createIndexQuery('notes_normalized_is_todo', 'notes_normalized', ['is_todo']));
				queries.push(createIndexQuery('notes_normalized_todo_completed', 'notes_normalized', ['todo_completed']));
				queries.push(createIndexQuery('notes_normalized_parent_id', 'notes_normalized', ['parent_id']));
				queries.push(createIndexQuery('notes_normalized_latitude', 'notes_normalized', ['latitude']));
				queries.push(createIndexQuery('notes_normalized_longitude', 'notes_normalized', ['longitude']));
				queries.push(createIndexQuery('notes_normalized_altitude', 'notes_normalized', ['altitude']));
				queries.push(createIndexQuery('notes_normalized_source_url', 'notes_normalized', ['source_url']));

				const columnNames = ['id', 'title', 'body', 'user_created_time', 'user_updated_time', 'is_todo', 'todo_completed', 'parent_id', 'latitude', 'longitude', 'altitude', 'source_url'];
				const notIndexed = ['id', 'user_created_time', 'user_updated_time', 'is_todo', 'todo_completed', 'parent_id', 'latitude', 'longitude', 'altitude', 'source_url'];

				queries.push(createFtsTableQuery('notes_fts', ['content="notes_normalized"', ...notIndexed.map(n => `notindexed="${n}"`)], columnNames));

				queries = queries.concat(createFtsTriggerQueries({
					ftsTableName: 'notes_fts',
					contentTableName: 'notes_normalized',
					columnNames,
					triggerNames: notesFtsTriggerNames,
				}));
				queries.push(addMigrationFile(33));
			}

			if (targetVersion === 34) {
				queries.push(createVirtualTableQuery('search_aux', 'fts4aux(notes_fts)'));
				queries.push(createVirtualTableQuery('notes_spellfix', 'spellfix1'));
			}

			if (targetVersion === 35) {
				queries.push(addColumnQuery('notes_normalized', intColumn('todo_due')));
				queries.push(createIndexQuery('notes_normalized_todo_due', 'notes_normalized', ['todo_due']));
				queries.push(addMigrationFile(35));
			}

			if (targetVersion === 36) {
				queries.push(addColumnQuery('folders', textColumn('share_id')));
				queries.push(addColumnQuery('notes', textColumn('share_id')));
				queries.push(addColumnQuery('resources', textColumn('share_id')));
			}

			if (targetVersion === 38) {
				queries.push(kysely.schema.dropView('tags_with_note_count'));
				queries.push(createTagsWithNoteCountView({ todoCompletedCount: true, excludeDeletedNotes: false }));
			}

			if (targetVersion === 39) {
				queries.push(addColumnQuery('notes', textColumn('conflict_original_id')));
			}

			if (targetVersion === 40) {
				queries.push(addColumnQuery('folders', textColumn('master_key_id')));
				queries.push(addColumnQuery('notes', textColumn('master_key_id')));
				queries.push(addColumnQuery('resources', textColumn('master_key_id')));
			}

			if (targetVersion === 41) {
				queries.push(addColumnQuery('folders', textColumn('icon')));
			}

			if (targetVersion > 41) {
				const migration = migrations[targetVersion - 42];
				if (!migration) throw new Error(`No such migration: ${targetVersion}`);
				const migrationQueries = migration();
				queries = queries.concat(migrationQueries);
			}

			const updateVersionQuery = kysely.updateTable('version').set({ version: targetVersion });

			queries.push(updateVersionQuery);

			try {
				await this.transactionExecBatch(queries);
			} catch (error) {
				// In some cases listed below, when the upgrade fail it is acceptable (a fallback will be used)
				// and in those cases, even though it fails, we still want to set the version number so that the
				// migration is not repeated on next upgrade.
				let saveVersionAgain = false;

				if (targetVersion === 15 || targetVersion === 18 || targetVersion === 33) {
					this.logger().warn('Could not upgrade to database v15 or v18 or v33 - FTS feature will not be used', error);
					saveVersionAgain = true;
				} else if (targetVersion === 34) {
					// if (!shim.isTestingEnv()) this.logger().warn('Could not upgrade to database v34 - fuzzy search will not be used', error);
					saveVersionAgain = true;
				} else {
					throw error;
				}

				if (saveVersionAgain) {
					this.logger().info('Migration failed with fallback and will not be repeated - saving version number');
					await this.transactionExecBatch([updateVersionQuery]);
				}
			}

			latestVersion = targetVersion;

			currentVersionIndex++;
		}

		return latestVersion;
	}

	public async ftsEnabled() {
		try {
			await this.selectOne(kysely.selectFrom('notes_fts').select(eb => eb.fn.countAll().as('total')));
		} catch (error) {
			this.logger().warn('FTS check failed', error);
			return false;
		}

		this.logger().info('FTS check succeeded');

		return true;
	}

	public async fuzzySearchEnabled() {
		try {
			await this.selectOne(dynamicKysely.selectFrom('notes_spellfix').select(eb => eb.fn.countAll().as('total')));
		} catch (error) {
			this.logger().warn('Fuzzy search check failed', error);
			return false;
		}
		this.logger().info('Fuzzy search check succeeded');
		return true;
	}

	public version() {
		return this.version_;
	}

	public async initialize() {
		this.logger().info('Checking for database schema update...');

		let versionRow = null;
		try {
			// Will throw if the database has not been created yet, but this is handled below
			versionRow = await this.selectOne(kysely.selectFrom('version').selectAll().limit(1));
		} catch (error) {
			if (error.message && error.message.indexOf('no such table: version') >= 0) {
				// Ignore
			} else {
				this.logger().info(error);
			}
		}

		const version = !versionRow ? 0 : versionRow.version;
		const tableFieldsVersion = !versionRow ? 0 : versionRow.table_fields_version;
		this.version_ = version;
		this.logger().info('Current database version', versionRow);

		const newVersion = await this.upgradeDatabase(version);
		this.version_ = newVersion;

		this.logger().info(`New version: ${newVersion}. Previously recorded version: ${tableFieldsVersion}`);

		if (newVersion !== tableFieldsVersion) await this.refreshTableFields(newVersion);

		this.tableFields_ = {};

		const rows = await this.selectAll(kysely.selectFrom('table_fields').selectAll());

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!this.tableFields_[row.table_name]) this.tableFields_[row.table_name] = [];
			this.tableFields_[row.table_name].push({
				name: row.field_name,
				type: row.field_type,
				default: Database.formatValue(row.field_type, row.field_default),
			});
		}
	}
}
