import { Migration } from '../types';
import { kysely } from '../kysely';
import { column, createTableQuery, intColumn, textColumn } from '../schemaUtils';

// Recreate conflict_note_states with a numeric auto-increment primary key, to
// match the convention used by the other tables. note_id keeps its uniqueness
// through a UNIQUE constraint. The table was added in migration 51 and hasn't
// shipped in a release yet, so it is safe to drop and recreate it rather than
// migrate the rows

const migration: Migration = () => {
	return [
		kysely.schema.dropTable('conflict_note_states').ifExists(),
		createTableQuery('conflict_note_states', [
			column('id', 'integer', { primaryKey: true, autoIncrement: true }),
			column('note_id', 'text', { notNull: true, unique: true }),
			textColumn('base_body'),
			textColumn('base_title'),
			textColumn('remote_body'),
			textColumn('remote_title'),
			intColumn('remote_updated_time'),
		]),
	];
};

export default migration;
