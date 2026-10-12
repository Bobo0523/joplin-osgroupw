import { Migration } from '../types';
import { addColumnQuery, intColumn, textColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('notes', intColumn('is_locked')),
		addColumnQuery('notes', textColumn('extracted_resource_ids')),
		addColumnQuery('revisions', intColumn('is_locked')),
		addColumnQuery('resources', intColumn('is_locked')),
	];
};

export default migration;
