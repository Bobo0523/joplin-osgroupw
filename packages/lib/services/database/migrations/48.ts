import { Migration } from '../types';
import { addColumnQuery, intColumn } from '../schemaUtils';

const migration: Migration = () => {
	return [
		addColumnQuery('resources', intColumn('ocr_driver_id', '1')),
	];
};

export default migration;
