import { Migration } from '../types';
import { addColumnQuery, column, createTableQuery, intColumn, textColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('sync_items', textColumn('base_body')),
		addColumnQuery('sync_items', textColumn('base_title')),
		addColumnQuery('sync_items', textColumn('base_conflict_note_id')),
		createTableQuery('conflict_note_states', [
			column('note_id', 'text', { primaryKey: true }),
			textColumn('base_body'),
			textColumn('base_title'),
			textColumn('remote_body'),
			textColumn('remote_title'),
			intColumn('remote_updated_time'),
		], { ifNotExists: true }),
	];
};

export default migration;
