import { Migration } from '../types';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('sync_items', 'remote_item_updated_time', column.integer(0)),
	];
};

export default migration;
