import { Migration } from '../types';
import { addColumnQuery, column, createIndexQuery, createTableQuery, intColumn, textColumn } from '../schemaUtils';
import { createFtsTableQuery, createFtsTriggerQueries } from '../sqlFragments';

const migration: Migration = () => {
	const columnNames = ['id', 'title', 'body', 'item_id', 'item_type', 'user_updated_time', 'reserved1', 'reserved2', 'reserved3', 'reserved4', 'reserved5', 'reserved6'];
	const notIndexed = ['id', 'item_id', 'item_type', 'user_updated_time', 'reserved1', 'reserved2', 'reserved3', 'reserved4', 'reserved5', 'reserved6'];

	return [
		addColumnQuery('resources', textColumn('ocr_text')),
		addColumnQuery('resources', textColumn('ocr_details')),
		addColumnQuery('resources', intColumn('ocr_status')),
		addColumnQuery('resources', textColumn('ocr_error')),

		createTableQuery('items_normalized', [
			column('id', 'integer', { primaryKey: true, autoIncrement: true }),
			textColumn('title'),
			textColumn('body'),
			column('item_id', 'text', { notNull: true }),
			column('item_type', 'int', { notNull: true }),
			intColumn('user_updated_time'),
			column('reserved1', 'int'),
			column('reserved2', 'int'),
			column('reserved3', 'int'),
			column('reserved4', 'int'),
			column('reserved5', 'int'),
			column('reserved6', 'int'),
		]),

		createIndexQuery('items_normalized_id', 'items_normalized', ['id']),
		createIndexQuery('items_normalized_item_id', 'items_normalized', ['item_id']),
		createIndexQuery('items_normalized_item_type', 'items_normalized', ['item_type']),

		createFtsTableQuery('items_fts', ['content="items_normalized"', ...notIndexed.map(n => `notindexed="${n}"`)], columnNames),

		...createFtsTriggerQueries({
			ftsTableName: 'items_fts',
			contentTableName: 'items_normalized',
			columnNames,
			triggerNames: ['items_fts_before_update', 'items_fts_before_delete', 'items_after_update', 'items_after_insert'],
		}),
	];
};

export default migration;
