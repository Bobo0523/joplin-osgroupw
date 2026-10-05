import { Migration } from '../types';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('sync_items', 'sync_warning_ignored', column.integer(0)),
	];
};

export default migration;
