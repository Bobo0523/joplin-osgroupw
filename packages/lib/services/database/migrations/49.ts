import { Migration } from '../types';
import { addColumnQuery, intColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('sync_items', intColumn('remote_item_updated_time')),
	];
};

export default migration;
