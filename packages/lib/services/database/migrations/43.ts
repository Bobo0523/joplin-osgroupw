import { Migration } from '../types';
import { addColumnQuery, textColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('notes', textColumn('user_data')),
		addColumnQuery('tags', textColumn('user_data')),
		addColumnQuery('folders', textColumn('user_data')),
		addColumnQuery('resources', textColumn('user_data')),
	];
};

export default migration;
