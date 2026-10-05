import { Migration } from '../types';
import { addColumn, column } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('resources', 'ocr_driver_id', column.integer(1)),
	];
};

export default migration;
