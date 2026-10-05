import { Migration } from '../types';
import { qb } from '../kysely';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('resources', 'blob_updated_time', column.integer(0)),
		qb.updateTable('resources').set(eb => ({ blob_updated_time: eb.ref('updated_time') })),
	];
};

export default migration;
