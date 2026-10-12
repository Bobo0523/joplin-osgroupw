import { kysely } from './kysely';

// The tags_with_note_count view, which was changed several times by the
// upgrade steps.
const tagsWithNoteCountQuery = (options: { todoCompletedCount: boolean; excludeDeletedNotes: boolean }) => {
	let query = kysely.selectFrom('tags')
		.leftJoin('note_tags as nt', 'nt.tag_id', 'tags.id')
		.leftJoin('notes', 'notes.id', 'nt.note_id')
		.select(eb => [
			'tags.id as id',
			'tags.title as title',
			'tags.created_time as created_time',
			'tags.updated_time as updated_time',
			eb.fn.count('notes.id').as('note_count'),
			// eslint-disable-next-line promise/prefer-await-to-then -- This is Kysely's CASE ... THEN builder, not a promise
			...(options.todoCompletedCount ? [eb.fn.sum(eb.case().when('notes.todo_completed', '>', 0).then(1).else(0).end()).as('todo_completed_count')] : []),
		])
		.where('notes.id', 'is not', null);
	if (options.excludeDeletedNotes) query = query.where('notes.deleted_time', '=', 0);
	return query.groupBy('tags.id');
};

const createTagsWithNoteCountView = (options: { todoCompletedCount: boolean; excludeDeletedNotes: boolean; ifNotExists?: boolean }) => {
	let query = kysely.schema.createView('tags_with_note_count');
	if (options.ifNotExists) query = query.ifNotExists();
	return query.as(tagsWithNoteCountQuery(options));
};

export default createTagsWithNoteCountView;
