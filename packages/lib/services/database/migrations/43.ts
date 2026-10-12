import { AnyQuery } from '../kysely';
import { schemaUserDataV43 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaUserDataV43(),
	];
};
