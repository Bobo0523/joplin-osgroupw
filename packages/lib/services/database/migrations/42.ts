import addMigrationFile from '../addMigrationFile';
import { AnyQuery } from '../kysely';

export default (): AnyQuery[] => {
	return [
		addMigrationFile(42),
	];
};
