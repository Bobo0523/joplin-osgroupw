import { AnyQuery } from '../kysely';
import { schemaOcrDriverIdV48 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaOcrDriverIdV48(),
	];
};
