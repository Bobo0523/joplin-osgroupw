import { Migration } from '../types';
import { addColumnQuery, intColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('sync_items', intColumn('sync_warning_ignored', '0')),
	];
};

export default migration;
