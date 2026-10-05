import BaseModel from '../BaseModel';
import { NoteEntity } from '../services/database/types';
import BaseItem from './BaseItem';
import { LoadOptions } from './utils/types';
import { dynamicQb, literalList, qb, Query, selectFields } from '../services/database/kysely';

export type AssociatedResourceNote = Partial<NoteEntity> & {
	resource_id: string;
	note_id: string;
};

// - If is_associated = 1, note_resources indicates which note_id is currently associated with the given resource_id
// - If is_associated = 0, note_resources indicates which note_id *was* associated with the given resource_id
// - last_seen_time tells the last time that resource was associated with this note.
// - If last_seen_time is 0, it means the resource has never been associated with any note.

export default class NoteResource extends BaseModel {
	public static tableName() {
		return 'note_resources';
	}

	public static modelType() {
		return BaseModel.TYPE_NOTE_RESOURCE;
	}

	public static async applySharedStatusToLinkedResources() {
		const queries: Query[] = [];

		queries.push(qb.updateTable('resources').set({ is_shared: 0 }));

		queries.push(
			qb.updateTable('resources')
				.set({ is_shared: 1 })
				.where('id', 'in', qb
					.selectFrom('notes')
					.innerJoin('note_resources', 'notes.id', 'note_resources.note_id')
					.select('note_resources.resource_id')
					.distinct()
					.where('notes.is_shared', '=', 1)),
		);

		await this.db().transactionExecBatch(queries);
	}

	// public static async updateResourceShareIds() {
	// 	// Find all resources where share_id is different from parent note
	// 	// share_id. Then update share_id on all these resources. Essentially it
	// 	// makes it match the resource share_id to the note share_id.

	// 	const sql = `
	// 		SELECT r.id, n.share_id
	// 		FROM note_resources nr
	// 		LEFT JOIN resources r ON nr.resource_id = r.id
	// 		LEFT JOIN notes n ON nr.note_id = n.id
	// 		WHERE n.share_id != r.share_id`;

	// 	const rows = await this.db().selectAll(sql);

	// 	const updatedTime = Date.now();
	// 	const queries: SqlQuery[] = [];

	// 	for (const row of rows) {
	// 		queries.push({
	// 			sql: `
	// 				UPDATE resources
	// 				SET share_id = ?, updated_time = ?
	// 				WHERE id = ?`,
	// 			params: [
	// 				row.share_id || '',
	// 				updatedTime,
	// 				row.id,
	// 			],
	// 		});
	// 	}

	// 	await this.db().transactionExecBatch(queries);
	// }

	public static async associatedNoteIds(resourceId: string): Promise<string[]> {
		const rows = await this.modelSelectAll(qb.selectFrom('note_resources').select('note_id').where('resource_id', '=', resourceId).where('is_associated', '=', 1));
		return rows.map((r: { note_id: string }) => r.note_id);
	}

	public static async associatedResourceNotes(resourceIds: string[], options: LoadOptions = null): Promise<Record<string, AssociatedResourceNote[]>> {
		if (!resourceIds.length) return {};

		const fields: string[] = options && options.fields ? (options.fields as string[]).slice() : [];
		fields.push('resource_id');
		fields.push('note_id');

		const query = dynamicQb.selectFrom('note_resources').leftJoin('notes', 'notes.id', 'note_resources.note_id');
		const rows = await this.modelSelectAll(selectFields(query, fields).where('resource_id', 'in', literalList(resourceIds)).where('is_associated', '=', 1));

		const output: Record<string, AssociatedResourceNote[]> = {};
		for (const row of rows) {
			if (!output[row.resource_id]) output[row.resource_id] = [];
			output[row.resource_id].push(row);
		}

		return output;
	}

	public static async setAssociatedResources(noteId: string, resourceIds: string[]) {
		const existingRows = await this.modelSelectAll(qb.selectFrom('note_resources').selectAll().where('note_id', '=', noteId));

		const notProcessedResourceIds = resourceIds.slice();
		const queries: Query[] = [];
		for (let i = 0; i < existingRows.length; i++) {
			const row = existingRows[i];
			const resourceIndex = resourceIds.indexOf(row.resource_id);

			if (resourceIndex >= 0) {
				queries.push(qb.updateTable('note_resources').set({ last_seen_time: Date.now(), is_associated: 1 }).where('id', '=', row.id));
				notProcessedResourceIds.splice(notProcessedResourceIds.indexOf(row.resource_id), 1);
			} else {
				queries.push(qb.updateTable('note_resources').set({ is_associated: 0 }).where('id', '=', row.id));
			}
		}

		for (let i = 0; i < notProcessedResourceIds.length; i++) {
			queries.push(dynamicQb.insertInto('note_resources').values({ note_id: noteId, resource_id: notProcessedResourceIds[i], is_associated: 1, last_seen_time: Date.now() }));
		}

		await this.db().transactionExecBatch(queries);
	}

	public static async addOrphanedResources() {
		const missingResources = await this.db().selectAll(
			qb.selectFrom('resources')
				.select('id')
				.where('id', 'not in', qb.selectFrom('note_resources').select('resource_id').distinct()),
		);
		const queries: Query[] = [];
		for (let i = 0; i < missingResources.length; i++) {
			const id = missingResources[i].id;

			// If the resource is not associated with any note, and has never
			// been synced, it means it's a local resource that was removed from
			// a note (or the note was deleted). In which case, we set a
			// "last_seen_time", so that it can be considered an orphan resource
			// that can be auto-deleted.
			//
			// https://github.com/laurent22/joplin/issues/932#issuecomment-933736405

			const hasBeenSynced = await BaseItem.itemHasBeenSynced(id);
			const lastSeenTime = hasBeenSynced ? 0 : Date.now();

			queries.push(dynamicQb.insertInto('note_resources').values({ note_id: '', resource_id: id, is_associated: 0, last_seen_time: lastSeenTime }));
		}
		await this.db().transactionExecBatch(queries);
	}

	public static async remove(noteId: string) {
		await this.db().exec(qb.updateTable('note_resources').set({ is_associated: 0 }).where('note_id', '=', noteId));
	}

	public static async orphanResources(expiryDelay: number = null) {
		if (expiryDelay === null) expiryDelay = 1000 * 60 * 60 * 24 * 10;
		const cutOffTime = Date.now() - expiryDelay;
		const output = await this.modelSelectAll(
			qb.selectFrom('note_resources')
				.select(eb => ['resource_id', eb.fn.sum('is_associated').as('sum(is_associated)')])
				.groupBy('resource_id')
				.having(eb => eb.fn.sum('is_associated'), '<=', 0)
				.having('last_seen_time', '<', cutOffTime)
				.having('last_seen_time', '!=', 0),
		);
		return output.map((r: { resource_id: string }) => r.resource_id);
	}

	public static async deleteByResource(resourceId: string) {
		await this.db().exec(qb.deleteFrom('note_resources').where('resource_id', '=', resourceId));
	}
}
