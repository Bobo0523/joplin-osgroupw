import { AnyQuery } from '../kysely';
import { schemaIsLockedV50 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaIsLockedV50(),
	];
};
