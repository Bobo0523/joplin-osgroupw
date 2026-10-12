import { AnyQuery, kysely } from '../kysely';
import { schemaConflictNoteStatesV53 } from '../sqlFragments';

// Recreate conflict_note_states with a numeric auto-increment primary key, to
// match the convention used by the other tables. note_id keeps its uniqueness
// through a UNIQUE constraint. The table was added in migration 51 and hasn't
// shipped in a release yet, so it is safe to drop and recreate it rather than
// migrate the rows

export default (): AnyQuery[] => {
	return [
		kysely.schema.dropTable('conflict_note_states').ifExists(),
		...schemaConflictNoteStatesV53(),
	];
};
