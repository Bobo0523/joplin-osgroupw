import BaseModel from '../BaseModel';
import JoplinDatabase from '../JoplinDatabase';
import { NoteEmbeddingsMetaEntity } from '../services/database/types';
import { AnyQuery, insertRow, kysely, toSqlQuery } from '../services/database/kysely';
import { lastInsertRowId, vecCreateTable, vecEmbeddingMatch, vecToJson } from '../services/database/sqlFragments';

// Storage for per-note chunk embeddings.
//
// Metadata lives in `note_embeddings_meta` (regular SQLite table, migration
// 52). Vectors live in `note_embeddings_vec`, a sqlite-vec `vec0` virtual
// table created lazily when sqlite-vec is available. Joined by rowid.
// Vector methods throw if sqlite-vec is missing; metadata methods work
// regardless.

interface SaveChunk {
	chunkIndex: number;
	chunkText: string;
	vector: number[];
}

interface SimilarityResult {
	noteId: string;
	chunkIndex: number;
	chunkText: string;
	distance: number;
}

interface SimilaritySearchOptions {
	k: number;
	// Raw L2 distance from vec0 (caller converts to cosine if needed).
	maxDistance?: number;
	// Pre-resolved scope filter. Empty array = search nothing.
	noteIds?: string[];
}

export default class NoteEmbedding extends BaseModel {

	public static tableName() {
		return 'note_embeddings_meta';
	}

	public static modelType() {
		return BaseModel.TYPE_NOTE_EMBEDDING;
	}

	private static joplinDb(): JoplinDatabase {
		return this.db() as JoplinDatabase;
	}

	// Single source of truth for "can we use vector search?". Callers that
	// would otherwise throw (the indexer, search APIs) should gate on this and
	// no-op when it's false, so users on platforms without sqlite-vec don't
	// get a flood of failed-to-index errors.
	public static vectorSearchAvailable(): boolean {
		return this.joplinDb().sqliteVecAvailable();
	}

	private static requireVec() {
		if (!this.vectorSearchAvailable()) {
			throw new Error('Vector search is unavailable: sqlite-vec extension is not loaded on this platform');
		}
	}

	// Called lazily — CREATE VIRTUAL TABLE fails without sqlite-vec loaded.
	public static async ensureVecTable(dimension: number) {
		this.requireVec();
		await this.db().exec(toSqlQuery(vecCreateTable(dimension).compile(kysely)));
	}

	public static async byNoteId(noteId: string): Promise<NoteEmbeddingsMetaEntity[]> {
		return this.db().selectAll<NoteEmbeddingsMetaEntity>(
			kysely.selectFrom('note_embeddings_meta').selectAll().where('note_id', '=', noteId).orderBy('chunk_index', 'asc'),
		);
	}

	public static async countByNoteId(noteId: string): Promise<number> {
		const row = await this.db().selectOne(
			kysely.selectFrom('note_embeddings_meta').select(eb => eb.fn.countAll().as('c')).where('note_id', '=', noteId),
		) as { c: number } | null;
		return row?.c ?? 0;
	}

	public static async distinctNoteIdCount(): Promise<number> {
		const row = await this.db().selectOne(
			kysely.selectFrom('note_embeddings_meta').select(eb => eb.fn.count('note_id').distinct().as('c')),
		) as { c: number } | null;
		return row?.c ?? 0;
	}

	// Indexable notes not yet embedded — drives the indexer's initial scan.
	// `excludeIds` lets the caller skip notes that already failed this session,
	// so a permanently bad note doesn't keep coming back.
	public static async notYetIndexedNoteIds(limit: number, excludeIds: string[] = []): Promise<string[]> {
		let query = kysely.selectFrom('notes as n')
			.select('n.id')
			.where(eb => eb.or([eb('n.deleted_time', 'is', null), eb('n.deleted_time', '=', 0)]))
			.where(eb => eb.or([eb('n.is_conflict', 'is', null), eb('n.is_conflict', '=', 0)]))
			.where('n.is_locked', '=', 0)
			.where(eb => eb.not(eb.exists(eb.selectFrom('note_embeddings_meta as m').select(eb.lit(1).as('one')).whereRef('m.note_id', '=', 'n.id'))));
		if (excludeIds.length) query = query.where('n.id', 'not in', excludeIds);
		const rows = await this.db().selectAll<{ id: string }>(query.limit(limit));
		return rows.map(r => r.id);
	}

	// Vec-table delete is guarded by sqliteVecAvailable() AND vecTableExists()
	// because saveChunks creates the vec table lazily.
	public static async deleteByNoteId(noteId: string) {
		const rows = await this.db().selectAll<{ id: number }>(
			kysely.selectFrom('note_embeddings_meta').select('id').where('note_id', '=', noteId),
		);
		if (!rows.length) return;
		const ids = rows.map(r => r.id);
		const queries: AnyQuery[] = [
			kysely.deleteFrom('note_embeddings_meta').where('id', 'in', ids),
		];
		if (this.joplinDb().sqliteVecAvailable() && await this.vecTableExists()) {
			queries.push(kysely.deleteFrom('note_embeddings_vec').where('rowid', 'in', ids));
		}
		await this.db().transactionExecBatch(queries);
	}

	private static async vecTableExists(): Promise<boolean> {
		const row = await this.db().selectOne(
			kysely.selectFrom('sqlite_master').select('name').where('type', '=', 'table').where('name', '=', 'note_embeddings_vec'),
		) as { name: string } | null;
		return !!row;
	}

	// Replaces every chunk for a note. modelId is stored per row so a future
	// model change can trigger a re-index. Not wrapped in a transaction: a
	// mid-save crash leaves a partial set, but the indexer reprocesses via
	// the ItemChange cursor and saveChunks begins by clearing the note.
	public static async saveChunks(noteId: string, modelId: string, chunks: SaveChunk[]) {
		this.requireVec();
		if (chunks.length === 0) {
			await this.deleteByNoteId(noteId);
			return;
		}

		const dimension = chunks[0].vector.length;
		for (const chunk of chunks) {
			if (chunk.vector.length !== dimension) {
				throw new Error(`All vectors for a note must have the same dimension. Got ${chunk.vector.length}, expected ${dimension}`);
			}
		}

		await this.ensureVecTable(dimension);
		await this.deleteByNoteId(noteId);

		const now = Date.now();
		for (const chunk of chunks) {
			// node-sqlite3's exec() doesn't return the insert id, so read it
			// back with last_insert_rowid(). The driver serialises queries on
			// the same connection so there's no race.
			await this.db().exec(kysely.insertInto('note_embeddings_meta').values(insertRow('note_embeddings_meta', {
				note_id: noteId,
				chunk_index: chunk.chunkIndex,
				model_id: modelId,
				chunk_text: chunk.chunkText,
				created_time: now,
			})));
			const row = await this.db().selectOne(kysely.selectNoFrom(lastInsertRowId().as('id'))) as { id: number } | null;
			const lastID = row?.id;
			if (!lastID) throw new Error('Failed to obtain rowid after embedding insert');

			// Wipe any orphan vec-row at this rowid before inserting. Orphans
			// show up when a prior saveChunks crashed between the meta insert
			// and the vec insert: meta was wiped on the next pass but the vec
			// row stayed, and sqlite later hands us the same rowid (#15761).
			// vec0 doesn't support INSERT OR REPLACE — explicit DELETE then INSERT.
			await this.db().exec(kysely.deleteFrom('note_embeddings_vec').where('rowid', '=', lastID));
			await this.db().exec(kysely.insertInto('note_embeddings_vec').values(insertRow('note_embeddings_vec', { rowid: lastID, embedding: JSON.stringify(chunk.vector) })));
		}
	}

	public static async similaritySearch(
		queryVector: number[],
		options: SimilaritySearchOptions,
	): Promise<SimilarityResult[]> {
		this.requireVec();
		if (!await this.vecTableExists()) return [];

		// Explicit empty noteIds = search nothing (vs undefined = search all).
		if (options.noteIds && options.noteIds.length === 0) return [];

		const k = Math.max(1, options.k | 0);

		// vec0 needs k inlined into the MATCH clause; a parameter-bound LIMIT
		// after a JOIN isn't visible to its planner. With a noteIds filter we
		// over-fetch 4× and trim after, so the post-join filter has room to
		// drop non-matches. Pathological vaults can still under-fill.
		const fetchSize = options.noteIds?.length ? k * 4 : k;

		let query = kysely.selectFrom('note_embeddings_vec as v')
			.innerJoin('note_embeddings_meta as m', 'm.id', 'v.rowid')
			.select(['m.note_id', 'm.chunk_index', 'm.chunk_text', 'v.distance'])
			.where(vecEmbeddingMatch(JSON.stringify(queryVector), fetchSize));

		if (options.noteIds && options.noteIds.length) {
			query = query.where('m.note_id', 'in', options.noteIds);
		}

		query = query.orderBy('v.distance').limit(k);

		const rows = await this.db().selectAll<{
			note_id: string;
			chunk_index: number;
			chunk_text: string;
			distance: number;
		}>(query);

		const results = rows.map(r => ({
			noteId: r.note_id,
			chunkIndex: r.chunk_index,
			chunkText: r.chunk_text,
			distance: r.distance,
		}));

		if (options.maxDistance !== undefined) {
			return results.filter(r => r.distance <= options.maxDistance);
		}
		return results;
	}

	// Page through stored chunks (with raw vectors) ordered by rowid. rowid is
	// monotonic on insert so a cursor positioned at rowid=N is guaranteed to
	// never miss a chunk with rowid<N inserted later — the only chunks the
	// caller can miss are those added ahead of an in-flight cursor, which is
	// the documented snapshot tradeoff for the plugin API.
	//
	// noteIds is an optional filter; afterRowid is the cursor (exclusive).
	// Returns rows in rowid order so the last row's id is the next cursor.
	public static async chunksPage(options: {
		noteIds?: string[];
		afterRowid?: number;
		limit: number;
	}): Promise<{ rowid: number; noteId: string; modelId: string; chunkIndex: number; chunkText: string; vector: number[] }[]> {
		this.requireVec();
		if (!await this.vecTableExists()) return [];
		if (options.noteIds && options.noteIds.length === 0) return [];

		let query = kysely.selectFrom('note_embeddings_meta as m')
			.innerJoin('note_embeddings_vec as v', 'v.rowid', 'm.id')
			.select(['m.id', 'm.note_id', 'm.model_id', 'm.chunk_index', 'm.chunk_text'])
			.select(vecToJson().as('embedding'));
		if (options.afterRowid !== undefined) {
			query = query.where('m.id', '>', options.afterRowid);
		}
		if (options.noteIds && options.noteIds.length) {
			query = query.where('m.note_id', 'in', options.noteIds);
		}

		const rows = await this.db().selectAll<{
			id: number;
			note_id: string;
			model_id: string;
			chunk_index: number;
			chunk_text: string;
			embedding: string;
		}>(query.orderBy('m.id', 'asc').limit(options.limit));

		return rows.map(r => ({
			rowid: r.id,
			noteId: r.note_id,
			modelId: r.model_id,
			chunkIndex: r.chunk_index,
			chunkText: r.chunk_text,
			vector: JSON.parse(r.embedding) as number[],
		}));
	}

	// Loads the stored vectors for a note's chunks in chunk-index order.
	// Lets noteId-based searches reuse indexed vectors instead of re-embedding.
	public static async vectorsByNoteId(noteId: string): Promise<number[][]> {
		this.requireVec();
		if (!await this.vecTableExists()) return [];
		const rows = await this.db().selectAll<{ embedding: string }>(
			kysely.selectFrom('note_embeddings_vec as v')
				.innerJoin('note_embeddings_meta as m', 'm.id', 'v.rowid')
				.select(vecToJson().as('embedding'))
				.where('m.note_id', '=', noteId)
				.orderBy('m.chunk_index', 'asc'),
		);
		return rows.map(r => JSON.parse(r.embedding) as number[]);
	}

	// Drops every embedding. Used when the active model's id changes.
	public static async clearAll() {
		const queries: AnyQuery[] = [kysely.deleteFrom('note_embeddings_meta')];
		if (this.joplinDb().sqliteVecAvailable() && await this.vecTableExists()) {
			queries.push(kysely.deleteFrom('note_embeddings_vec'));
		}
		await this.db().transactionExecBatch(queries);
	}
}
