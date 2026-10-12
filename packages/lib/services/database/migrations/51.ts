import { AnyQuery } from '../kysely';
import { schemaConflictStateV51 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaConflictStateV51(),
	];
};
