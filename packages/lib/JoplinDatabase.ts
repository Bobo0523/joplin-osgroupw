import Resource from './models/Resource';
import shim from './shim';
import Database, { Row } from './database';
import addMigrationFile from './services/database/addMigrationFile';
import migrations from './services/database/migrations';
import { AnyQuery, insertRow, kysely, toSqlQuery } from './services/database/kysely';
import { KyselyTableName } from './services/database/kyselyTypes';
import { SchemaBaseItemTable, schemaAlarmsV6, schemaConflictOriginalIdV39, schemaDeletedItemsV2, schemaEncryptionColumnsV9, schemaEncryptionFlagsV9, schemaFileExtensionV7, schemaFolderIconV41, schemaFolderParentIdV12, schemaIsSharedV26, schemaItemChangesAndNoteResourcesV10, schemaItemLocationV21, schemaKeyValuesV23, schemaMarkupLanguageV24, schemaMasterKeyIdV40, schemaMasterKeysV9, schemaMigrationsV20, schemaNotesFtsTriggersDropV18, schemaNotesFtsTriggersDropV33, schemaNotesFtsV15, schemaNotesFtsV18, schemaNotesNormalizedTableV18, schemaNotesNormalizedTodoDueV35, schemaNotesNormalizedV33, schemaResourceFetchStatusV13, schemaResourceLocalStatesIndexesV14, schemaResourceLocalStatesTableV14, schemaResourcesSizeIndexV28, schemaResourcesToDownloadV22, schemaRevisionsV19, schemaSearchAuxAndSpellfixV34, schemaShareIdV36, schemaStructureV1, schemaSyncDisabledV8, schemaTableFieldsVersionV29, schemaTableInfo, schemaTagParentIdV31, schemaTagsWithNoteCountV25, schemaTagsWithNoteCountV32, schemaTagsWithNoteCountV38, schemaUserTimeColumnsV5, schemaUserUpdatedTimeIndexV5 } from './services/database/sqlFragments';

const { sprintf } = require('sprintf-js');

// Steps 13 and 14 use resources.fetch_status and fetch_error, which were later moved to resource_local_states.
const legacyResourcesKysely = kysely.withTables<{ resources: { fetch_status: number; fetch_error: string } }>();

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
		const tableNames: KyselyTableName[] = [
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

		const queries: AnyQuery[] = [];
		for (const n of tableNames) {
			queries.push(kysely.deleteFrom(n));
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
		for (const key of settingKeys) {
			queries.push(kysely.deleteFrom('settings').where('key', '=', key));
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

	private async countFields(tableName: string): Promise<number> {
		const pragmas = await this.selectAll(schemaTableInfo(tableName));
		if (!pragmas) throw new Error(`No such table: ${tableName}`);
		return pragmas.length;
	}

	public async refreshTableFields(newVersion: number) {
		this.logger().info('Initializing tables...');
		const queries: AnyQuery[] = [];
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

				pragmas = await this.selectAll(schemaTableInfo(tableName));

				for (let i = 0; i < pragmas.length; i++) {
					const item = pragmas[i];
					// In SQLite, if the default value is a string it has quotes around it, so remove them here
					let defaultValue = item.dflt_value;
					if (typeof defaultValue === 'string' && defaultValue.length >= 2 && (defaultValue[0] === '"' || defaultValue[0] === '\'') && defaultValue[defaultValue.length - 1] === defaultValue[0]) {
						defaultValue = defaultValue.substr(1, defaultValue.length - 2);
					}
					queries.push(kysely.insertInto('table_fields').values(insertRow('table_fields', {
						table_name: tableName,
						field_name: item.name,
						field_type: Database.enumId('fieldType', item.type),
						field_default: defaultValue,
					})));
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

			let queries: AnyQuery[] = [];

			if (targetVersion === 1) {
				queries.push(...schemaStructureV1());
				queries.push(kysely.insertInto('version').values(insertRow('version', { version: 1 })));
			}

			if (targetVersion === 2) {
				queries.push(kysely.schema.dropTable('deleted_items'));
				queries.push(...schemaDeletedItemsV2());
			}

			if (targetVersion === 3) {
				queries = this.alterColumnQueries('settings', { key: 'TEXT PRIMARY KEY', value: 'TEXT' });
			}

			if (targetVersion === 4) {
				queries.push(kysely.insertInto('settings').values(eb => ({ key: 'sync.3.context', value: eb.selectFrom('settings').select('value').where('key', '=', 'sync.context') })));
				queries.push(kysely.deleteFrom('settings').where('key', '=', 'sync.context'));
			}

			if (targetVersion === 5) {
				const tableNames: SchemaBaseItemTable[] = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					const n = tableNames[i];
					queries.push(...schemaUserTimeColumnsV5(n));
					queries.push(kysely.updateTable(n).set(eb => ({ user_created_time: eb.ref('created_time') })));
					queries.push(kysely.updateTable(n).set(eb => ({ user_updated_time: eb.ref('updated_time') })));
					queries.push(schemaUserUpdatedTimeIndexV5(n));
				}
			}

			if (targetVersion === 6) {
				queries.push(...schemaAlarmsV6());
			}

			if (targetVersion === 7) {
				queries.push(...schemaFileExtensionV7());
			}

			if (targetVersion === 8) {
				queries.push(...schemaSyncDisabledV8());
			}

			if (targetVersion === 9) {
				queries.push(schemaMasterKeysV9());
				const tableNames: SchemaBaseItemTable[] = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					queries.push(...schemaEncryptionColumnsV9(tableNames[i]));
				}

				queries.push(...schemaEncryptionFlagsV9());
			}

			const upgradeVersion10 = () => {
				queries.push(...schemaItemChangesAndNoteResourcesV10());

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
				queries.push(...schemaFolderParentIdV12());
			}

			if (targetVersion === 13) {
				queries.push(...schemaResourceFetchStatusV13());
				queries.push(legacyResourcesKysely.updateTable('resources').set({ fetch_status: Resource.FETCH_STATUS_DONE }));
			}

			if (targetVersion === 14) {
				queries.push(schemaResourceLocalStatesTableV14());

				queries.push(legacyResourcesKysely.insertInto('resource_local_states')
					.columns(['id', 'resource_id', 'fetch_status', 'fetch_error'])
					.expression(legacyResourcesKysely.selectFrom('resources').select(eb => [eb.lit(null).as('id'), 'id as resource_id', 'fetch_status', 'fetch_error'])));

				queries.push(...schemaResourceLocalStatesIndexesV14());

				queries = queries.concat(
					this.alterColumnQueries('resources', {
						id: 'TEXT PRIMARY KEY',
						title: 'TEXT NOT NULL DEFAULT ""',
						mime: 'TEXT NOT NULL',
						filename: 'TEXT NOT NULL DEFAULT ""',
						created_time: 'INT NOT NULL',
						updated_time: 'INT NOT NULL',
						user_created_time: 'INT NOT NULL DEFAULT 0',
						user_updated_time: 'INT NOT NULL DEFAULT 0',
						file_extension: 'TEXT NOT NULL DEFAULT ""',
						encryption_cipher_text: 'TEXT NOT NULL DEFAULT ""',
						encryption_applied: 'INT NOT NULL DEFAULT 0',
						encryption_blob_encrypted: 'INT NOT NULL DEFAULT 0',
					}),
				);
			}

			if (targetVersion === 15) {
				queries.push(...schemaNotesFtsV15());
			}

			if (targetVersion === 18) {
				queries.push(...schemaNotesNormalizedTableV18());
				queries.push(...schemaNotesFtsTriggersDropV18());
				queries.push(kysely.schema.dropTable('notes_fts').ifExists());
				queries.push(...schemaNotesFtsV18());
			}

			if (targetVersion === 19) {
				queries.push(...schemaRevisionsV19());
			}

			if (targetVersion === 20) {
				queries.push(...schemaMigrationsV20());
				queries.push(addMigrationFile(20));
			}

			if (targetVersion === 21) {
				queries.push(...schemaItemLocationV21());
			}

			if (targetVersion === 22) {
				queries.push(...schemaResourcesToDownloadV22());
			}

			if (targetVersion === 23) {
				queries.push(...schemaKeyValuesV23());
			}

			if (targetVersion === 24) {
				queries.push(...schemaMarkupLanguageV24());
			}

			if (targetVersion === 25) {
				queries.push(...schemaTagsWithNoteCountV25());
			}

			if (targetVersion === 26) {
				const tableNames: SchemaBaseItemTable[] = ['notes', 'folders', 'tags', 'note_tags', 'resources'];
				for (let i = 0; i < tableNames.length; i++) {
					queries.push(schemaIsSharedV26(tableNames[i]));
				}
			}

			if (targetVersion === 27) {
				queries.push(addMigrationFile(27));
			}

			if (targetVersion === 28) {
				queries.push(...schemaResourcesSizeIndexV28());
			}

			if (targetVersion === 29) {
				queries.push(...schemaTableFieldsVersionV29());
			}

			if (targetVersion === 30) {
				// Change the type of the "order" field from INT to NUMERIC
				// Making it a float provides a much bigger range when inserting notes.
				// For example, with an INT, inserting a note C between note A with order 1000 and
				// note B with order 1001 wouldn't be possible without changing the order
				// value of note A or B. But with a float, we can set the order of note C to 1000.5
				queries = queries.concat(
					this.alterColumnQueries('notes', {
						id: 'TEXT PRIMARY KEY',
						parent_id: 'TEXT NOT NULL DEFAULT ""',
						title: 'TEXT NOT NULL DEFAULT ""',
						body: 'TEXT NOT NULL DEFAULT ""',
						created_time: 'INT NOT NULL',
						updated_time: 'INT NOT NULL',
						is_conflict: 'INT NOT NULL DEFAULT 0',
						latitude: 'NUMERIC NOT NULL DEFAULT 0',
						longitude: 'NUMERIC NOT NULL DEFAULT 0',
						altitude: 'NUMERIC NOT NULL DEFAULT 0',
						author: 'TEXT NOT NULL DEFAULT ""',
						source_url: 'TEXT NOT NULL DEFAULT ""',
						is_todo: 'INT NOT NULL DEFAULT 0',
						todo_due: 'INT NOT NULL DEFAULT 0',
						todo_completed: 'INT NOT NULL DEFAULT 0',
						source: 'TEXT NOT NULL DEFAULT ""',
						source_application: 'TEXT NOT NULL DEFAULT ""',
						application_data: 'TEXT NOT NULL DEFAULT ""',
						order: 'NUMERIC NOT NULL DEFAULT 0', // that's the change!
						user_created_time: 'INT NOT NULL DEFAULT 0',
						user_updated_time: 'INT NOT NULL DEFAULT 0',
						encryption_cipher_text: 'TEXT NOT NULL DEFAULT ""',
						encryption_applied: 'INT NOT NULL DEFAULT 0',
						markup_language: 'INT NOT NULL DEFAULT 1',
						is_shared: 'INT NOT NULL DEFAULT 0',
					}),
				);
			}

			if (targetVersion === 31) {
				// This empty version is due to the revert of the hierarchical tag feature
				// We need to keep the version for the users who have upgraded using
				// the pre-release
				queries.push(...schemaTagParentIdV31());
				// Drop the tag note count view, instead compute note count on the fly
				// queries.push('DROP VIEW tags_with_note_count');
				// queries.push(addMigrationFile(31));
			}

			if (targetVersion === 32) {
				// This is the same as version 25 - this is to complete the
				// revert of the hierarchical tag feature.
				queries.push(...schemaTagsWithNoteCountV32());
			}

			if (targetVersion === 33) {
				queries.push(...schemaNotesFtsTriggersDropV33());

				queries.push(kysely.schema.dropIndex('notes_normalized_id'));
				queries.push(kysely.schema.dropTable('notes_normalized'));
				queries.push(kysely.schema.dropTable('notes_fts'));

				queries.push(...schemaNotesNormalizedV33());
				queries.push(addMigrationFile(33));
			}

			if (targetVersion === 34) {
				queries.push(...schemaSearchAuxAndSpellfixV34());
			}

			if (targetVersion === 35) {
				queries.push(...schemaNotesNormalizedTodoDueV35());
				queries.push(addMigrationFile(35));
			}

			if (targetVersion === 36) {
				queries.push(...schemaShareIdV36());
			}

			if (targetVersion === 38) {
				queries.push(kysely.schema.dropView('tags_with_note_count'));
				queries.push(...schemaTagsWithNoteCountV38());
			}

			if (targetVersion === 39) {
				queries.push(...schemaConflictOriginalIdV39());
			}

			if (targetVersion === 40) {
				queries.push(...schemaMasterKeyIdV40());
			}

			if (targetVersion === 41) {
				queries.push(...schemaFolderIconV41());
			}

			if (targetVersion > 41) {
				const migration = migrations[targetVersion - 42];
				if (!migration) throw new Error(`No such migration: ${targetVersion}`);
				const migrationQueries = migration();
				queries = queries.concat(migrationQueries);
			}

			const updateVersionQuery = toSqlQuery(kysely.updateTable('version').set({ version: targetVersion }));

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
			await this.selectOne(kysely.selectFrom('notes_fts').select(eb => eb.fn.countAll().as('count(*)')));
		} catch (error) {
			this.logger().warn('FTS check failed', error);
			return false;
		}

		this.logger().info('FTS check succeeded');

		return true;
	}

	public async fuzzySearchEnabled() {
		try {
			await this.selectOne(kysely.selectFrom('notes_spellfix').select(eb => eb.fn.countAll().as('count(*)')));
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
