import { Migration } from '../types';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('notes', 'is_locked', column.integer(0)),
		addColumn('notes', 'extracted_resource_ids', column.text('')),
		addColumn('revisions', 'is_locked', column.integer(0)),
		addColumn('resources', 'is_locked', column.integer(0)),
	];
};

export default migration;
