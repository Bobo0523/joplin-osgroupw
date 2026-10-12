import { AnyQuery, kysely } from '../kysely';
import { schemaDeletedTimeV46, schemaTagsWithNoteCountV46 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return [
		...schemaDeletedTimeV46(),
		kysely.schema.dropView('tags_with_note_count'),
		...schemaTagsWithNoteCountV46(),
	];
};
