import { Migration } from '../types';
import { qb } from '../kysely';
import { column, createTable } from '../schema';

// Recreate conflict_note_states with a numeric auto-increment primary key, to
// match the convention used by the other tables. note_id keeps its uniqueness
// through a UNIQUE constraint. The table was added in migration 51 and hasn't
// shipped in a release yet, so it is safe to drop and recreate it rather than
// migrate the rows

const migration: Migration = () => {
	return [
		qb.schema.dropTable('conflict_note_states').ifExists(),
		createTable('conflict_note_states', {
			id: column.autoIncrementPrimaryKey(),
			note_id: ['text', c => c.notNull().unique()],
			base_body: column.text(''),
			base_title: column.text(''),
			remote_body: column.text(''),
			remote_title: column.text(''),
			remote_updated_time: column.integer(0),
		}),
	];
};

export default migration;
