import { Migration } from '../types';
import { addColumn, column, createTable } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('sync_items', 'base_body', column.text('')),
		addColumn('sync_items', 'base_title', column.text('')),
		addColumn('sync_items', 'base_conflict_note_id', column.text('')),
		createTable('conflict_note_states', {
			note_id: column.textPrimaryKey(),
			base_body: column.text(''),
			base_title: column.text(''),
			remote_body: column.text(''),
			remote_title: column.text(''),
			remote_updated_time: column.integer(0),
		}, { ifNotExists: true }),
	];
};

export default migration;
