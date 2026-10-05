import { Migration } from '../types';
import { sql } from '../kysely';
import { addColumn, column, createIndex, createTable } from '../schema';

const migration: Migration = () => {
	const tableFields = ['id', 'title', 'body', 'item_id', 'item_type', 'user_updated_time', 'reserved1', 'reserved2', 'reserved3', 'reserved4', 'reserved5', 'reserved6'];
	const notIndexedFields = ['id', 'item_id', 'item_type', 'user_updated_time', 'reserved1', 'reserved2', 'reserved3', 'reserved4', 'reserved5', 'reserved6'];

	const fieldList = sql.join(tableFields.map(f => sql.ref(f)));
	const ftsOptions = [sql`content=${sql.lit('items_normalized')}`].concat(notIndexedFields.map(f => sql`notindexed=${sql.lit(f)}`));

	return [
		addColumn('resources', 'ocr_text', column.text('')),
		addColumn('resources', 'ocr_details', column.text('')),
		addColumn('resources', 'ocr_status', column.integer(0)),
		addColumn('resources', 'ocr_error', column.text('')),

		createTable('items_normalized', {
			id: column.autoIncrementPrimaryKey(),
			title: column.text(''),
			body: column.text(''),
			item_id: column.text(),
			item_type: column.integer(),
			user_updated_time: column.integer(0),
			reserved1: column.nullableInteger(),
			reserved2: column.nullableInteger(),
			reserved3: column.nullableInteger(),
			reserved4: column.nullableInteger(),
			reserved5: column.nullableInteger(),
			reserved6: column.nullableInteger(),
		}),

		createIndex('items_normalized_id', 'items_normalized', 'id'),
		createIndex('items_normalized_item_id', 'items_normalized', 'item_id'),
		createIndex('items_normalized_item_type', 'items_normalized', 'item_type'),

		// Virtual tables and triggers are not supported by the Kysely schema
		// builder, so they are written using the `sql` template tag.
		sql`CREATE VIRTUAL TABLE items_fts USING fts4(${sql.join(ftsOptions.concat(tableFields.map(f => sql.ref(f))))})`,

		sql`
			CREATE TRIGGER items_fts_before_update BEFORE UPDATE ON items_normalized BEGIN
				DELETE FROM items_fts WHERE docid=old.rowid;
			END;`,
		sql`
			CREATE TRIGGER items_fts_before_delete BEFORE DELETE ON items_normalized BEGIN
				DELETE FROM items_fts WHERE docid=old.rowid;
			END;`,
		sql`
			CREATE TRIGGER items_after_update AFTER UPDATE ON items_normalized BEGIN
				INSERT INTO items_fts(docid, ${fieldList}) SELECT rowid, ${fieldList} FROM items_normalized WHERE new.rowid = items_normalized.rowid;
			END;`,
		sql`
			CREATE TRIGGER items_after_insert AFTER INSERT ON items_normalized BEGIN
				INSERT INTO items_fts(docid, ${fieldList}) SELECT rowid, ${fieldList} FROM items_normalized WHERE new.rowid = items_normalized.rowid;
			END;`,
	];
};

export default migration;
