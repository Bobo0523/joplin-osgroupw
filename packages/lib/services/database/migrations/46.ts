import { Migration } from '../types';
import { kysely } from '../kysely';
import { addColumnQuery, intColumn } from '../schemaUtils';
import createTagsWithNoteCountView from '../tagsWithNoteCountView';

const migration: Migration = () => {
	return [
		addColumnQuery('notes', intColumn('deleted_time')),
		addColumnQuery('folders', intColumn('deleted_time')),
		kysely.schema.dropView('tags_with_note_count'),
		createTagsWithNoteCountView({ todoCompletedCount: true, excludeDeletedNotes: true }),
	];
};

export default migration;
