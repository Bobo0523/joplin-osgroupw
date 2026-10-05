import Resource from './models/Resource';
import shim from './shim';
import Database, { Row } from './database';
import { SqlQuery } from './services/database/types';
import addMigrationFile from './services/database/addMigrationFile';
import migrations from './services/database/migrations';
import { RawBuilder } from 'kysely';
import { dynamicQb, qb, Query, sql } from './services/database/kysely';
import { addColumn, clearTablesQueries, column, createIndex, createTable, createTagsWithNoteCountView } from './services/database/schema';

const { sprintf } = require('sprintf-js');

const structureQueries = (): Query[] => {
	return [
		createTable('folders', {
			id: column.textPrimaryKey(),
			title: column.text(''),
			created_time: column.integer(),
			updated_time: column.integer(),
		}),

		createIndex('folders_title', 'folders', 'title'),
		createIndex('folders_updated_time', 'folders', 'updated_time'),

		createTable('notes', {
			id: column.textPrimaryKey(),
			parent_id: column.text(''),
			title: column.text(''),
			body: column.text(''),
			created_time: column.integer(),
			updated_time: column.integer(),
			is_conflict: column.integer(0),
			latitude: column.numeric(0),
			longitude: column.numeric(0),
			altitude: column.numeric(0),
			author: column.text(''),
			source_url: column.text(''),
			is_todo: column.integer(0),
			todo_due: column.integer(0),
			todo_completed: column.integer(0),
			source: column.text(''),
			source_application: column.text(''),
			application_data: column.text(''),
			order: column.integer(0),
		}),

		createIndex('notes_title', 'notes', 'title'),
		createIndex('notes_updated_time', 'notes', 'updated_time'),
		createIndex('notes_is_conflict', 'notes', 'is_conflict'),
		createIndex('notes_is_todo', 'notes', 'is_todo'),
		createIndex('notes_order', 'notes', 'order'),

		createTable('tags', {
			id: column.textPrimaryKey(),
			title: column.text(''),
			created_time: column.integer(),
			updated_time: column.integer(),
		}),

		createIndex('tags_title', 'tags', 'title'),
		createIndex('tags_updated_time', 'tags', 'updated_time'),

		createTable('note_tags', {
			id: column.textPrimaryKey(),
			note_id: column.text(),
			tag_id: column.text(),
			created_time: column.integer(),
			updated_time: column.integer(),
		}),

		createIndex('note_tags_note_id', 'note_tags', 'note_id'),
		createIndex('note_tags_tag_id', 'note_tags', 'tag_id'),
		createIndex('note_tags_updated_time', 'note_tags', 'updated_time'),

		createTable('resources', {
			id: column.textPrimaryKey(),
			title: column.text(''),
			mime: column.text(),
			filename: column.text(''),
			created_time: column.integer(),
			updated_time: column.integer(),
		}),

		createIndex('resources_title', 'resources', 'title'),
		createIndex('resources_updated_time', 'resources', 'updated_time'),

		createTable('settings', {
			key: column.textPrimaryKey(),
			value: column.nullableText(),
			type: column.integer(),
		}),

		createTable('table_fields', {
			id: column.integerPrimaryKey(),
			table_name: column.text(),
			field_name: column.text(),
			field_type: column.integer(),
			field_default: column.nullableText(),
		}),

		createTable('sync_items', {
			id: column.integerPrimaryKey(),
			sync_target: column.integer(),
			sync_time: column.integer(0),
			item_type: column.integer(),
			item_id: column.text(),
		}),

		createIndex('sync_items_sync_time', 'sync_items', 'sync_time'),
		createIndex('sync_items_sync_target', 'sync_items', 'sync_target'),
		createIndex('sync_items_item_type', 'sync_items', 'item_type'),
		createIndex('sync_items_item_id', 'sync_items', 'item_id'),

		createTable('deleted_items', {
			id: column.integerPrimaryKey(),
			item_type: column.integer(),
			item_id: column.text(),
			deleted_time: column.integer(),
		}),

		createTable('version', {
			version: column.integer(),
		}),

		dynamicQb.insertInto('version').values({ version: 1 }),
	];
};

// The FTS virtual tables and their triggers cannot be expressed with the Kysely
// schema builder, so they are written with the Kysely `sql` template tag.
const ftsTriggerQueries = (ftsTable: string, contentTable: string, triggerPrefix: string, ftsTriggerPrefix: string, fields: string[], insertCondition: RawBuilder<unknown> = null) => {
	const fieldList = sql.join(fields.map(f => sql.ref(f)));
	const condition = insertCondition ? sql`${insertCondition} AND ` : sql``;
	return [
		sql`CREATE TRIGGER ${sql.id(`${ftsTriggerPrefix}_before_update`)} BEFORE UPDATE ON ${sql.table(contentTable)} BEGIN
			DELETE FROM ${sql.table(ftsTable)} WHERE docid=old.rowid;
		END;`,
		sql`CREATE TRIGGER ${sql.id(`${ftsTriggerPrefix}_before_delete`)} BEFORE DELETE ON ${sql.table(contentTable)} BEGIN
			DELETE FROM ${sql.table(ftsTable)} WHERE docid=old.rowid;
		END;`,
		sql`CREATE TRIGGER ${sql.id(`${triggerPrefix}_after_update`)} AFTER UPDATE ON ${sql.table(contentTable)} BEGIN
			INSERT INTO ${sql.table(ftsTable)}(docid, ${fieldList}) SELECT rowid, ${fieldList} FROM ${sql.table(contentTable)} WHERE ${condition}new.rowid = ${sql.table(contentTable)}.rowid;
		END;`,
		sql`CREATE TRIGGER ${sql.id(`${triggerPrefix}_after_insert`)} AFTER INSERT ON ${sql.table(contentTable)} BEGIN
			INSERT INTO ${sql.table(ftsTable)}(docid, ${fieldList}) SELECT rowid, ${fieldList} FROM ${sql.table(contentTable)} WHERE ${condition}new.rowid = ${sql.table(contentTable)}.rowid;
		END;`,
	];
};

const ftsVirtualTableQuery = (ftsTable: string, contentTable: string, notIndexedFields: string[], fields: string[]) => {
	const options = [sql`content=${sql.lit(contentTable)}`].concat(notIndexedFields.map(f => sql`notindexed=${sql.lit(f)}`));
	return sql`CREATE VIRTUAL TABLE ${sql.table(ftsTable)} USING fts4(${sql.join(options.concat(fields.map(f => sql.ref(f))))})`;
};

const dropNotesFtsTriggerQueries = (ifExists: boolean) => {
	const ifExistsSql = ifExists ? sql`IF EXISTS ` : sql``;
	return ['notes_fts_before_update', 'notes_fts_before_delete', 'notes_after_update', 'notes_after_insert'].map(name => {
		return sql`DROP TRIGGER ${ifExistsSql}${sql.id(name)}`;
	});
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

		const queries = clearTablesQueries(tableNames);

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

		for (const key of settingKeys) {
			queries.push(qb.deleteFrom('settings').where('key', '=', key));
		}

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

	private tableInfoQuery(tableName: string) {
		return sql<Row>`PRAGMA table_info(${sql.id(tableName)})`;
	}

	private async countFields(tableName: string): Promise<number> {
		const pragmas = await this.selectAll(this.tableInfoQuery(tableName));
		if (!pragmas) throw new Error(`No such table: ${tableName}`);
		return pragmas.length;
	}

	public async refreshTableFields(newVersion: number) {
		this.logger().info('Initializing tables...');
		const queries: SqlQuery[] = [];
		queries.push(this.wrapQuery(qb.deleteFrom('table_fields')));

		const countFieldsNotesFts = await this.countFields('notes_fts');
		const countFieldsItemsFts = await this.countFields('items_fts');
		if (countFieldsNotesFts !== countFieldsItemsFts) {
			throw new Error(`\`notes_fts\` (${countFieldsNotesFts} fields) must have the same number of fields as \`items_fts\` (${countFieldsItemsFts} fields) for the search engine BM25 algorithm to work`);
		}

		const tableRows = await this.selectAll(qb.selectFrom('sqlite_master').select('name').where('type', '=', 'table'));

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

				pragmas = await this.selectAll(this.tableInfoQuery(tableName));

				for (let i = 0; i < pragmas.length; i++) {
					const item = pragmas[i];
					// In SQLite, if the default value is a string it has quotes around it, so remove them here. Older
					// tables were created with double quotes, while the Kysely schema builder uses single quotes.
					let defaultValue = item.dflt_value;
					if (typeof defaultValue === 'string' && defaultValue.length >= 2 && (defaultValue[0] === '"' || defaultValue[0] === '\'') && defaultValue[defaultValue.length - 1] === defaultValue[0]) {
						defaultValue = defaultValue.substr(1, defaultValue.length - 2);
					}
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

		queries.push(this.wrapQuery(qb.updateTable('version').set({ table_fields_version: newVersion })));
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

			let queries: (SqlQuery | Query)[] = [];

			if (targetVersion === 1) {
				queries = structureQueries();
			}

			if (targetVersion === 2) {
				queries.push(qb.schema.dropTable('deleted_items'));
				queries.push(createTable('deleted_items', {
					id: column.integerPrimaryKey(),
					item_type: column.integer(),
					item_id: column.text(),
					deleted_time: column.integer(),
					sync_target: column.integer(),
				}));
				queries.push(createIndex('deleted_items_sync_target', 'deleted_items', 'sync_target'));
			}

			if (targetVersion === 3) {
				queries = this.alterColumnQueries('settings', { key: column.textPrimaryKey(), value: column.nullableText() });
			}

			if (targetVersion === 4) {
				queries.push(dynamicQb.insertInto('settings').values({
					key: 'sync.3.context',
					value: dynamicQb.selectFrom('settings').select('value').where('key', '=', 'sync.context'),
				}));
				queries.push(qb.deleteFrom('settings').where('key', '=', 'sync.context'));
			}

			if (targetVersion === 5) {
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumn(n, 'user_created_time', column.integer(0)));
					queries.push(addColumn(n, 'user_updated_time', column.integer(0)));
					queries.push(dynamicQb.updateTable(n).set(eb => ({ user_created_time: eb.ref('created_time') })));
					queries.push(dynamicQb.updateTable(n).set(eb => ({ user_updated_time: eb.ref('updated_time') })));
					queries.push(createIndex(`${n}_user_updated_time`, n, 'user_updated_time'));
				}
			}

			if (targetVersion === 6) {
				queries.push(createTable('alarms', {
					id: column.autoIncrementPrimaryKey(),
					note_id: column.text(),
					trigger_time: column.integer(),
				}));
				queries.push(createIndex('alarm_note_id', 'alarms', 'note_id'));
			}

			if (targetVersion === 7) {
				queries.push(addColumn('resources', 'file_extension', column.text('')));
			}

			if (targetVersion === 8) {
				queries.push(addColumn('sync_items', 'sync_disabled', column.integer(0)));
				queries.push(addColumn('sync_items', 'sync_disabled_reason', column.text('')));
			}

			if (targetVersion === 9) {
				queries.push(createTable('master_keys', {
					id: column.textPrimaryKey(),
					created_time: column.integer(),
					updated_time: column.integer(),
					source_application: column.text(),
					encryption_method: column.integer(),
					checksum: column.text(),
					content: column.text(),
				}));
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumn(n, 'encryption_cipher_text', column.text('')));
					queries.push(addColumn(n, 'encryption_applied', column.integer(0)));
					queries.push(createIndex(`${n}_encryption_applied`, n, 'encryption_applied'));
				}

				queries.push(addColumn('sync_items', 'force_sync', column.integer(0)));
				queries.push(addColumn('resources', 'encryption_blob_encrypted', column.integer(0)));
			}

			const upgradeVersion10 = () => {
				queries.push(createTable('item_changes', {
					id: column.autoIncrementPrimaryKey(),
					item_type: column.integer(),
					item_id: column.text(),
					type: column.integer(),
					created_time: column.integer(),
				}));
				queries.push(createIndex('item_changes_item_id', 'item_changes', 'item_id'));
				queries.push(createIndex('item_changes_created_time', 'item_changes', 'created_time'));
				queries.push(createIndex('item_changes_item_type', 'item_changes', 'item_type'));

				queries.push(createTable('note_resources', {
					id: column.integerPrimaryKey(),
					note_id: column.text(),
					resource_id: column.text(),
					is_associated: column.integer(),
					last_seen_time: column.integer(),
				}));
				queries.push(createIndex('note_resources_note_id', 'note_resources', 'note_id'));
				queries.push(createIndex('note_resources_resource_id', 'note_resources', 'resource_id'));

				queries.push(qb.insertInto('item_changes')
					.columns(['item_type', 'item_id', 'type', 'created_time'])
					.expression(qb.selectFrom('notes').select([sql.lit(1).as('item_type'), 'id', sql.lit(1).as('type'), sql.val(Date.now()).as('created_time')])));
			};

			if (targetVersion === 10) {
				upgradeVersion10();
			}

			if (targetVersion === 11) {
				// This trick was needed because Electron Builder incorrectly released a dev branch containing v10 as it was
				// still being developed, and the db schema was not final at that time. So this v11 was created to
				// make sure any invalid db schema that was accidentally created was deleted and recreated.
				queries.push(qb.schema.dropTable('item_changes'));
				queries.push(qb.schema.dropTable('note_resources'));
				upgradeVersion10();
			}

			if (targetVersion === 12) {
				queries.push(addColumn('folders', 'parent_id', column.text('')));
			}

			if (targetVersion === 13) {
				queries.push(addColumn('resources', 'fetch_status', column.integer(2)));
				queries.push(addColumn('resources', 'fetch_error', column.text('')));
				queries.push(dynamicQb.updateTable('resources').set({ fetch_status: Resource.FETCH_STATUS_DONE }));
			}

			if (targetVersion === 14) {
				queries.push(createTable('resource_local_states', {
					id: column.integerPrimaryKey(),
					resource_id: column.text(),
					fetch_status: column.integer(2),
					fetch_error: column.text(''),
				}));

				queries.push(dynamicQb.insertInto('resource_local_states').expression(dynamicQb.selectFrom('resources').select([sql.lit(null).as('id'), 'id', 'fetch_status', 'fetch_error'])));

				queries.push(createIndex('resource_local_states_resource_id', 'resource_local_states', 'resource_id'));
				queries.push(createIndex('resource_local_states_resource_fetch_status', 'resource_local_states', 'fetch_status'));

				queries = queries.concat(
					this.alterColumnQueries('resources', {
						id: column.textPrimaryKey(),
						title: column.text(''),
						mime: column.text(),
						filename: column.text(''),
						created_time: column.integer(),
						updated_time: column.integer(),
						user_created_time: column.integer(0),
						user_updated_time: column.integer(0),
						file_extension: column.text(''),
						encryption_cipher_text: column.text(''),
						encryption_applied: column.integer(0),
						encryption_blob_encrypted: column.integer(0),
					}),
				);
			}

			if (targetVersion === 15) {
				queries.push(ftsVirtualTableQuery('notes_fts', 'notes', ['id'], ['id', 'title', 'body']));
				queries.push(dynamicQb.insertInto('notes_fts')
					.columns(['docid', 'id', 'title', 'body'])
					.expression(dynamicQb.selectFrom('notes').select(['rowid', 'id', 'title', 'body']).where('is_conflict', '=', 0).where('encryption_applied', '=', 0)));

				// Keep the content tables (notes) and the FTS table (notes_fts) in sync.
				// More info at https://www.sqlite.org/fts3.html#_external_content_fts4_tables_
				queries = queries.concat(ftsTriggerQueries('notes_fts', 'notes', 'notes', 'notes_fts', ['id', 'title', 'body'], sql`is_conflict = 0 AND encryption_applied = 0`));
			}

			if (targetVersion === 18) {
				queries.push(createTable('notes_normalized', {
					id: column.text(),
					title: column.text(''),
					body: column.text(''),
				}));

				queries.push(createIndex('notes_normalized_id', 'notes_normalized', 'id'));

				queries = queries.concat(dropNotesFtsTriggerQueries(true));
				queries.push(qb.schema.dropTable('notes_fts').ifExists());

				queries.push(ftsVirtualTableQuery('notes_fts', 'notes_normalized', ['id'], ['id', 'title', 'body']));

				// Keep the content tables (notes) and the FTS table (notes_fts) in sync.
				// More info at https://www.sqlite.org/fts3.html#_external_content_fts4_tables_
				queries = queries.concat(ftsTriggerQueries('notes_fts', 'notes_normalized', 'notes', 'notes_fts', ['id', 'title', 'body']));
			}

			if (targetVersion === 19) {
				queries.push(createTable('revisions', {
					id: column.textPrimaryKey(),
					parent_id: column.text(''),
					item_type: column.integer(),
					item_id: column.text(),
					item_updated_time: column.integer(),
					title_diff: column.text(''),
					body_diff: column.text(''),
					metadata_diff: column.text(''),
					encryption_cipher_text: column.text(''),
					encryption_applied: column.integer(0),
					updated_time: column.integer(),
					created_time: column.integer(),
				}));

				queries.push(createIndex('revisions_parent_id', 'revisions', 'parent_id'));
				queries.push(createIndex('revisions_item_type', 'revisions', 'item_type'));
				queries.push(createIndex('revisions_item_id', 'revisions', 'item_id'));
				queries.push(createIndex('revisions_item_updated_time', 'revisions', 'item_updated_time'));
				queries.push(createIndex('revisions_updated_time', 'revisions', 'updated_time'));

				queries.push(addColumn('item_changes', 'source', column.integer(1)));
				queries.push(addColumn('item_changes', 'before_change_item', column.text('')));
			}

			if (targetVersion === 20) {
				queries.push(createTable('migrations', {
					id: column.integerPrimaryKey(),
					number: column.integer(),
					updated_time: column.integer(),
					created_time: column.integer(),
				}));

				queries.push(addColumn('resources', 'size', column.integer(-1)));
				queries.push(addMigrationFile(20));
			}

			if (targetVersion === 21) {
				queries.push(addColumn('sync_items', 'item_location', column.integer(1)));
			}

			if (targetVersion === 22) {
				queries.push(createTable('resources_to_download', {
					id: column.integerPrimaryKey(),
					resource_id: column.text(),
					updated_time: column.integer(),
					created_time: column.integer(),
				}));

				queries.push(createIndex('resources_to_download_resource_id', 'resources_to_download', 'resource_id'));
				queries.push(createIndex('resources_to_download_updated_time', 'resources_to_download', 'updated_time'));
			}

			if (targetVersion === 23) {
				queries.push(createTable('key_values', {
					id: column.integerPrimaryKey(),
					key: column.text(),
					value: column.text(),
					type: column.integer(),
					updated_time: column.integer(),
				}));

				queries.push(createIndex('key_values_key', 'key_values', 'key', { unique: true }));
			}

			if (targetVersion === 24) {
				queries.push(addColumn('notes', 'markup_language', column.integer(1))); // 1: Markdown, 2: HTML
			}

			if (targetVersion === 25) {
				queries.push(createTagsWithNoteCountView(false, false));
			}

			if (targetVersion === 26) {
				const tableNames = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(addColumn(n, 'is_shared', column.integer(0)));
				}
			}

			if (targetVersion === 27) {
				queries.push(addMigrationFile(27));
			}

			if (targetVersion === 28) {
				queries.push(createIndex('resources_size', 'resources', 'size'));
			}

			if (targetVersion === 29) {
				queries.push(addColumn('version', 'table_fields_version', column.integer(0)));
			}

			if (targetVersion === 30) {
				// Change the type of the "order" field from INT to NUMERIC
				// Making it a float provides a much bigger range when inserting notes.
				// For example, with an INT, inserting a note C between note A with order 1000 and
				// note B with order 1001 wouldn't be possible without changing the order
				// value of note A or B. But with a float, we can set the order of note C to 1000.5
				queries = queries.concat(
					this.alterColumnQueries('notes', {
						id: column.textPrimaryKey(),
						parent_id: column.text(''),
						title: column.text(''),
						body: column.text(''),
						created_time: column.integer(),
						updated_time: column.integer(),
						is_conflict: column.integer(0),
						latitude: column.numeric(0),
						longitude: column.numeric(0),
						altitude: column.numeric(0),
						author: column.text(''),
						source_url: column.text(''),
						is_todo: column.integer(0),
						todo_due: column.integer(0),
						todo_completed: column.integer(0),
						source: column.text(''),
						source_application: column.text(''),
						application_data: column.text(''),
						order: column.numeric(0), // that's the change!
						user_created_time: column.integer(0),
						user_updated_time: column.integer(0),
						encryption_cipher_text: column.text(''),
						encryption_applied: column.integer(0),
						markup_language: column.integer(1),
						is_shared: column.integer(0),
					}),
				);
			}

			if (targetVersion === 31) {
				// This empty version is due to the revert of the hierarchical tag feature
				// We need to keep the version for the users who have upgraded using
				// the pre-release
				queries.push(addColumn('tags', 'parent_id', column.text('')));
				// Drop the tag note count view, instead compute note count on the fly
				// queries.push('DROP VIEW tags_with_note_count');
				// queries.push(addMigrationFile(31));
			}

			if (targetVersion === 32) {
				// This is the same as version 25 - this is to complete the
				// revert of the hierarchical tag feature.
				queries.push(createTagsWithNoteCountView(false, false, true));
			}

			if (targetVersion === 33) {
				queries = queries.concat(dropNotesFtsTriggerQueries(false));

				queries.push(qb.schema.dropIndex('notes_normalized_id'));
				queries.push(qb.schema.dropTable('notes_normalized'));
				queries.push(qb.schema.dropTable('notes_fts'));

				queries.push(createTable('notes_normalized', {
					id: column.text(),
					title: column.text(''),
					body: column.text(''),
					user_created_time: column.integer(0),
					user_updated_time: column.integer(0),
					is_todo: column.integer(0),
					todo_completed: column.integer(0),
					parent_id: column.text(''),
					latitude: column.numeric(0),
					longitude: column.numeric(0),
					altitude: column.numeric(0),
					source_url: column.text(''),
				}));

				queries.push(createIndex('notes_normalized_id', 'notes_normalized', 'id'));

				queries.push(createIndex('notes_normalized_user_created_time', 'notes_normalized', 'user_created_time'));
				queries.push(createIndex('notes_normalized_user_updated_time', 'notes_normalized', 'user_updated_time'));
				queries.push(createIndex('notes_normalized_is_todo', 'notes_normalized', 'is_todo'));
				queries.push(createIndex('notes_normalized_todo_completed', 'notes_normalized', 'todo_completed'));
				queries.push(createIndex('notes_normalized_parent_id', 'notes_normalized', 'parent_id'));
				queries.push(createIndex('notes_normalized_latitude', 'notes_normalized', 'latitude'));
				queries.push(createIndex('notes_normalized_longitude', 'notes_normalized', 'longitude'));
				queries.push(createIndex('notes_normalized_altitude', 'notes_normalized', 'altitude'));
				queries.push(createIndex('notes_normalized_source_url', 'notes_normalized', 'source_url'));

				const tableFields = ['id', 'title', 'body', 'user_created_time', 'user_updated_time', 'is_todo', 'todo_completed', 'parent_id', 'latitude', 'longitude', 'altitude', 'source_url'];
				const notIndexedFields = ['id', 'user_created_time', 'user_updated_time', 'is_todo', 'todo_completed', 'parent_id', 'latitude', 'longitude', 'altitude', 'source_url'];

				queries.push(ftsVirtualTableQuery('notes_fts', 'notes_normalized', notIndexedFields, tableFields));

				queries = queries.concat(ftsTriggerQueries('notes_fts', 'notes_normalized', 'notes', 'notes_fts', tableFields));
				queries.push(addMigrationFile(33));
			}

			if (targetVersion === 34) {
				queries.push(sql`CREATE VIRTUAL TABLE search_aux USING fts4aux(notes_fts)`);
				queries.push(sql`CREATE VIRTUAL TABLE notes_spellfix USING spellfix1`);
			}

			if (targetVersion === 35) {
				queries.push(addColumn('notes_normalized', 'todo_due', column.integer(0)));
				queries.push(createIndex('notes_normalized_todo_due', 'notes_normalized', 'todo_due'));
				queries.push(addMigrationFile(35));
			}

			if (targetVersion === 36) {
				queries.push(addColumn('folders', 'share_id', column.text('')));
				queries.push(addColumn('notes', 'share_id', column.text('')));
				queries.push(addColumn('resources', 'share_id', column.text('')));
			}

			if (targetVersion === 38) {
				queries.push(qb.schema.dropView('tags_with_note_count'));
				queries.push(createTagsWithNoteCountView(true, false));
			}

			if (targetVersion === 39) {
				queries.push(addColumn('notes', 'conflict_original_id', column.text('')));
			}

			if (targetVersion === 40) {
				queries.push(addColumn('folders', 'master_key_id', column.text('')));
				queries.push(addColumn('notes', 'master_key_id', column.text('')));
				queries.push(addColumn('resources', 'master_key_id', column.text('')));
			}

			if (targetVersion === 41) {
				queries.push(addColumn('folders', 'icon', column.text('')));
			}

			if (targetVersion > 41) {
				const migration = migrations[targetVersion - 42];
				if (!migration) throw new Error(`No such migration: ${targetVersion}`);
				const migrationQueries = migration();
				queries = queries.concat(migrationQueries);
			}

			const updateVersionQuery = qb.updateTable('version').set({ version: targetVersion });

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
			await this.selectOne(qb.selectFrom('notes_fts').select(eb => eb.fn.countAll().as('count')));
		} catch (error) {
			this.logger().warn('FTS check failed', error);
			return false;
		}

		this.logger().info('FTS check succeeded');

		return true;
	}

	public async fuzzySearchEnabled() {
		try {
			await this.selectOne(qb.selectFrom('notes_spellfix').select(eb => eb.fn.countAll().as('count')));
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
			versionRow = await this.selectOne(qb.selectFrom('version').selectAll().limit(1));
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

		const rows = await this.selectAll(qb.selectFrom('table_fields').selectAll());

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
