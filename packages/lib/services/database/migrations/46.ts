import { Migration } from '../types';
import { qb } from '../kysely';
import { addColumn, column, createTagsWithNoteCountView } from '../schema';

const migration: Migration = () => {
	return [
		addColumn('notes', 'deleted_time', column.integer(0)),
		addColumn('folders', 'deleted_time', column.integer(0)),
		qb.schema.dropView('tags_with_note_count'),
		createTagsWithNoteCountView(true, true),
	];
};

export default migration;
