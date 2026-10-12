import { AnyQuery } from '../kysely';
import { schemaRemoteItemUpdatedTimeV49 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaRemoteItemUpdatedTimeV49(),
	];
};
