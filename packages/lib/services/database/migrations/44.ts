import { Migration } from '../types';
import { kysely } from '../kysely';
import { addColumnQuery, intColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('resources', intColumn('blob_updated_time')),
		kysely.updateTable('resources').set(eb => ({ blob_updated_time: eb.ref('updated_time') })),
	];
};

export default migration;
