import { Migration } from '../types';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('notes', 'user_data', column.text('')),
		addColumn('tags', 'user_data', column.text('')),
		addColumn('folders', 'user_data', column.text('')),
		addColumn('resources', 'user_data', column.text('')),
	];
};

export default migration;
