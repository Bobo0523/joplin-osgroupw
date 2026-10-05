import { Migration } from '../types';
import { column, createIndex, createTable } from '../schema';

// Storage for the AI embeddings index. Two tables:
//
// - `note_embeddings_meta` holds the per-chunk metadata. It is a regular table
//   so the metadata (chunk text, source note ID, model identifier) can be
//   inspected and managed even on platforms where the sqlite-vec extension
//   isn't available.
//
// - `note_embeddings_vec` is the sqlite-vec virtual table holding the actual
//   vectors. It is created lazily by the embeddings code when sqlite-vec is
//   available, because virtual-table syntax differs by extension version and
//   trying to create it unconditionally would break startup on platforms
//   without the prebuilt.
//
// Neither table is synced — embeddings are large, model-specific, and easily
// re-derivable on demand.

const migration: Migration = () => {
	return [
		createTable('note_embeddings_meta', {
			id: column.autoIncrementPrimaryKey(),
			note_id: column.text(),
			chunk_index: column.integer(),
			model_id: column.text(),
			chunk_text: column.text(),
			created_time: column.integer(0),
		}, { ifNotExists: true }),
		createIndex('note_embeddings_meta_note_id', 'note_embeddings_meta', 'note_id', { ifNotExists: true }),
		createIndex('note_embeddings_meta_note_chunk', 'note_embeddings_meta', ['note_id', 'chunk_index'], { ifNotExists: true, unique: true }),
	];
};

export default migration;
