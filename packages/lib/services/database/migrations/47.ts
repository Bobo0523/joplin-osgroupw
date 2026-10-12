import { AnyQuery } from '../kysely';
import { schemaSyncWarningIgnoredV47 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaSyncWarningIgnoredV47(),
	];
};
