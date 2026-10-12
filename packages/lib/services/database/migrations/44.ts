import { AnyQuery, kysely } from '../kysely';
import { schemaBlobUpdatedTimeV44 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaBlobUpdatedTimeV44(),
		kysely.updateTable('resources').set(eb => ({ blob_updated_time: eb.ref('updated_time') })),
	];
};
