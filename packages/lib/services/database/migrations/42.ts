import addMigrationFile from '../addMigrationFile';
import { Migration } from '../types';

const migration: Migration = () => {
	return [
		addMigrationFile(42),
	];
};

export default migration;
