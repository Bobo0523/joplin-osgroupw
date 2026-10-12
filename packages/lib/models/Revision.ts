import BaseModel, { DeleteOptions, ModelType } from '../BaseModel';
import { RevisionEntity } from '../services/database/types';
import BaseItem from './BaseItem';
const DiffMatchPatch = require('diff-match-patch');
import * as ArrayUtils from '../ArrayUtils';
import JoplinError from '../JoplinError';
import time from '../time';
import { kysely } from '../services/database/kysely';
import { literalList } from '../services/database/sqlFragments';
import { QueryInput } from '../database';
const { sprintf } = require('sprintf-js');

const dmp = new DiffMatchPatch();

export interface ObjectPatch {
	new: Record<string, unknown>;
	deleted: string[];
}

export default class Revision extends BaseItem {
	public static tableName() {
		return 'revisions';
	}

	public static modelType() {
		return BaseModel.TYPE_REVISION;
	}

	public static createTextPatchLegacy(oldText: string, newText: string): string {
		return dmp.patch_toText(dmp.patch_make(oldText, newText));
	}

	public static createTextPatch(oldText: string, newText: string): string {
		// Note that, once parsed, the resulting object will not exactly be like
		// a dmp patch object. This is because the library overrides the
		// toString() prototype function of the dmp patch object, and uses it in
		// certain functions. For example, in patch_toText(). It means that when
		// calling patch_toText() with an object that has been JSON-stringified
		// and JSON-parsed, it will not work.
		//
		// This is mostly fine for our purpose. It's only a problem in
		// Revision.patchStats() because it was based on parsing the GNU diff
		// as returned by patch_toText().
		return JSON.stringify(dmp.patch_make(oldText, newText));
	}

	public static applyTextPatchLegacy(text: string, patch: string): string {
		patch = dmp.patch_fromText(patch);
		const result = dmp.patch_apply(patch, text);
		if (!result || !result.length) throw new Error('Could not apply patch');
		return result[0];
	}

	private static isLegacyPatch(patch: string): boolean {
		return patch && patch.indexOf('@@') === 0;
	}

	private static isNewPatch(patch: string): boolean {
		if (!patch) return true;
		return patch.indexOf('[{') === 0 || patch === '[]';
	}

	public static applyTextPatch(text: string, patch: string): string {
		if (this.isLegacyPatch(patch)) {
			return this.applyTextPatchLegacy(text, patch);
		} else {
			// An empty patch should be '[]', but legacy data may be just "".
			// However an empty string would make JSON.parse fail so we set it
			// to '[]'.
			const result = dmp.patch_apply(this.parsePatch(patch), text);
			if (!result || !result.length) throw new Error('Could not apply patch');
			return result[0];
		}
	}

	public static isEmptyRevision(rev: RevisionEntity): boolean {
		if (this.isLegacyPatch(rev.title_diff) && rev.title_diff) return false;
		if (this.isLegacyPatch(rev.body_diff) && rev.body_diff) return false;

		if (this.isNewPatch(rev.title_diff) && rev.title_diff && rev.title_diff !== '[]') return false;
		if (this.isNewPatch(rev.body_diff) && rev.body_diff && rev.body_diff !== '[]') return false;

		const md = rev.metadata_diff ? JSON.parse(rev.metadata_diff) : {};
		if (md.new && Object.keys(md.new).length) return false;
		if (md.deleted && Object.keys(md.deleted).length) return false;

		return true;
	}

	public static createObjectPatch(oldObject: Record<string, unknown>, newObject: Record<string, unknown>) {
		if (!oldObject) oldObject = {};

		const output: ObjectPatch = {
			new: {},
			deleted: [],
		};

		for (const k in newObject) {
			if (!newObject.hasOwnProperty(k)) continue;
			if (oldObject[k] === newObject[k]) continue;
			output.new[k] = newObject[k];
		}

		for (const k in oldObject) {
			if (!oldObject.hasOwnProperty(k)) continue;
			if (!(k in newObject)) output.deleted.push(k);
		}

		return JSON.stringify(output);
	}

	// We need to sanitise the object patch because it seems some are broken and
	// may contain new lines: https://github.com/laurent22/joplin/issues/6209
	private static sanitizeObjectPatch(patch: string): string {
		return patch.replace(/[\n\r]/g, '');
	}

	public static applyObjectPatch(object: Record<string, unknown>, patch: string) {
		const parsedPatch: ObjectPatch = JSON.parse(this.sanitizeObjectPatch(patch));
		const output = { ...object };

		for (const k in parsedPatch.new) {
			output[k] = parsedPatch.new[k];
		}

		for (let i = 0; i < parsedPatch.deleted.length; i++) {
			delete output[parsedPatch.deleted[i]];
		}

		return output;
	}

	// Turn a new-style patch into an approximation of a GNU diff format.
	// Approximation, because the only goal is to put "+" or "-" before each
	// line, so that it can be processed by patchStats().
	private static newPatchToDiffFormat(patch: string): string {
		const changeList: string[] = [];
		const patchArray = this.parsePatch(patch);
		for (const patchItem of patchArray) {
			for (const d of patchItem.diffs) {
				if (d[0] !== 0) changeList.push(d[0] < 0 ? `-${d[1].replace(/[\n\r]/g, ' ')}` : `+${d[1].trim().replace(/[\n\r]/g, ' ')}`);
			}
		}
		return changeList.join('\n');
	}

	public static patchStats(patch: string) {
		if (typeof patch === 'object') throw new Error('Not implemented');

		if (this.isNewPatch(patch)) {
			try {
				patch = this.newPatchToDiffFormat(patch);
			} catch (error) {
				// Normally it should work but if it doesn't we don't want it to
				// crash the app since it's just presentational. But log an
				// error so that it can eventually be fixed.
				console.error('Could not generate diff:', error, patch);
				return { added: 0, removed: 0 };
			}
		}

		const countChars = (diffLine: string) => {
			return unescape(diffLine).length - 1;
		};

		const lines = patch.split('\n');
		let added = 0;
		let removed = 0;

		for (const line of lines) {
			if (line.indexOf('-') === 0) {
				removed += countChars(line);
				continue;
			}

			if (line.indexOf('+') === 0) {
				added += countChars(line);
				continue;
			}
		}

		return {
			added: added,
			removed: removed,
		};
	}

	public static revisionPatchStatsText(rev: RevisionEntity) {
		const titleStats = this.patchStats(rev.title_diff);
		const bodyStats = this.patchStats(rev.body_diff);
		const total = {
			added: titleStats.added + bodyStats.added,
			removed: titleStats.removed + bodyStats.removed,
		};

		const output = [];
		if (total.removed) output.push(`-${total.removed}`);
		output.push(`+${total.added}`);
		return output.join(', ');
	}

	public static async countRevisions(itemType: ModelType, itemId: string) {
		const r = await this.db().selectOne(kysely.selectFrom('revisions').select(eb => eb.fn.countAll().as('total')).where('item_type', '=', itemType).where('item_id', '=', itemId));

		return r ? r.total : 0;
	}

	public static latestRevision(itemType: ModelType, itemId: string) {
		return this.modelSelectOne(kysely.selectFrom('revisions').selectAll().where('item_type', '=', itemType).where('item_id', '=', itemId).orderBy('item_updated_time', 'desc').limit(1));
	}

	public static allByType(itemType: ModelType, itemId: string) {
		return this.modelSelectAll(kysely.selectFrom('revisions').selectAll().where('item_type', '=', itemType).where('item_id', '=', itemId).orderBy('item_updated_time', 'asc'));
	}

	public static async itemsWithRevisions(itemType: ModelType, itemIds: string[]) {
		if (!itemIds.length) return [];
		const rows = await this.db().selectAll(kysely.selectFrom('revisions').select('item_id').distinct().where('item_type', '=', itemType).where('item_id', 'in', literalList(itemIds)));

		return rows.map((r: RevisionEntity) => r.item_id);
	}

	public static async itemsWithNoRevisions(itemType: ModelType, itemIds: string[]) {
		const withRevs = await this.itemsWithRevisions(itemType, itemIds);
		const output = [];
		for (let i = 0; i < itemIds.length; i++) {
			if (withRevs.indexOf(itemIds[i]) < 0) output.push(itemIds[i]);
		}
		return ArrayUtils.unique(output);
	}

	public static moveRevisionToTop(revision: RevisionEntity, revs: RevisionEntity[]) {
		let targetIndex = -1;
		for (let i = revs.length - 1; i >= 0; i--) {
			const rev = revs[i];
			if (rev.id === revision.id) {
				targetIndex = i;
				break;
			}
		}

		if (targetIndex < 0) throw new Error(`Could not find revision: ${revision.id}`);

		if (targetIndex !== revs.length - 1) {
			revs = revs.slice();
			const toTop = revs[targetIndex];
			revs.splice(targetIndex, 1);
			revs.push(toTop);
		}

		return revs;
	}

	// Note: revs must be sorted by update_time ASC (as returned by allByType)
	public static async mergeDiffs(revision: RevisionEntity, revs: RevisionEntity[] = null) {
		if (!('encryption_applied' in revision) || !!revision.encryption_applied) throw new JoplinError('Target revision is encrypted', 'revision_encrypted');

		if (!revs) {
			revs = await this.modelSelectAll(
				kysely.selectFrom('revisions').selectAll()
					.where('item_type', '=', revision.item_type)
					.where('item_id', '=', revision.item_id)
					.where('item_updated_time', '<=', revision.item_updated_time)
					.orderBy('item_updated_time', 'asc'),
			);
		} else {
			revs = revs.slice();
		}

		if (revs.find(item => item.id === revision.id) !== undefined) {
			// Handle rare case where two revisions have been created at exactly the same millisecond
			// Also handle even rarer case where a rev and its parent have been created at the
			// same milliseconds. All code below expects target revision to be on top.
			revs = this.moveRevisionToTop(revision, revs);
		} else {
			revs.push(revision);
		}

		const output = {
			title: '',
			body: '',
			metadata: {},
		};

		// Build up the list of revisions that are parents of the target revision.
		const revIndexes = [revs.length - 1];
		let parentId = revision.parent_id;
		for (let i = revs.length - 2; i >= 0; i--) {
			const rev = revs[i];
			if (rev.id !== parentId) continue;
			parentId = rev.parent_id;
			revIndexes.push(i);
		}
		revIndexes.reverse();

		for (const revIndex of revIndexes) {
			const rev = revs[revIndex];
			if (rev.encryption_applied) throw new JoplinError(sprintf('Revision "%s" is encrypted', rev.id), 'revision_encrypted');
			output.title = this.applyTextPatch(output.title, rev.title_diff);
			output.body = this.applyTextPatch(output.body, rev.body_diff);
			try {
				output.metadata = this.applyObjectPatch(output.metadata, rev.metadata_diff);
			} catch (error) {
				error.message = `Revision ${rev.id}: Could not apply patch: ${error.message}: ${rev.metadata_diff}`;
				throw error;
			}
		}

		return output;
	}

	private static async findAllRevisionsToKeep(itemType: ModelType, itemId: string, cutOffDate: number) {
		return this.modelSelectAll(
			kysely.selectFrom('revisions as child')
				.innerJoin('revisions as parent', 'child.parent_id', 'parent.id')
				.selectAll('child')
				.where('child.item_type', '=', itemType)
				.where('child.item_id', '=', itemId)
				.where('child.item_updated_time', '>=', cutOffDate)
				.where('parent.item_type', '=', itemType)
				.where('parent.item_id', '=', itemId)
				.where('parent.item_updated_time', '<', cutOffDate)
				.orderBy('child.item_updated_time', 'asc'),
		);
	}

	public static async deleteOldRevisions(ttl: number) {
		// When deleting old revisions, we need to make sure that the oldest surviving revision
		// is a "merged" one (as opposed to a diff from a now deleted revision). So every time
		// we deleted a revision, we need to find if there's a corresponding surviving revision
		// and modify that revision into a "merged" one.

		const cutOffDate = Date.now() - ttl;
		const allOldRevisions: RevisionEntity[] = await this.modelSelectAll(
			kysely.selectFrom('revisions').selectAll().where('item_updated_time', '<', cutOffDate).orderBy('item_updated_time', 'asc'),
		);

		const itemIdToOldRevisions = new Map<string, RevisionEntity[]>();
		for (const rev of allOldRevisions) {
			const itemId = rev.item_id;
			if (!itemIdToOldRevisions.has(itemId)) {
				itemIdToOldRevisions.set(itemId, []);
			}
			itemIdToOldRevisions.get(itemId).push(rev);
		}

		const deleteOldRevisionsForItem = async (itemType: ModelType, itemId: string, oldRevisions: RevisionEntity[]) => {
			const firstKeptRev = await this.modelSelectOne(
				kysely.selectFrom('revisions').selectAll()
					.where('item_updated_time', '>=', cutOffDate)
					.where('item_type', '=', itemType)
					.where('item_id', '=', itemId)
					.orderBy('item_updated_time', 'asc')
					.limit(1),
			);
			const queries: QueryInput[] = [];
			if (!firstKeptRev) {
				const hasEncrypted = await this.modelSelectOne(
					kysely.selectFrom('revisions').selectAll()
						.where('encryption_applied', '=', 1)
						.where('item_updated_time', '<', cutOffDate)
						.where('item_id', '=', itemId),
				);
				if (hasEncrypted) {
					throw new JoplinError('One of the revision to be deleted is encrypted', 'revision_encrypted');
				}
			} else {
				const revsToMerge = await this.findAllRevisionsToKeep(itemType, itemId, cutOffDate);

				for (const keptRev of revsToMerge) {
					// Note: we don't need to check for encrypted rev here because
					// mergeDiff will already throw the revision_encrypted exception
					// if a rev is encrypted.
					const merged = await this.mergeDiffs(keptRev, oldRevisions);

					const titleDiff = this.createTextPatch('', merged.title);
					const bodyDiff = this.createTextPatch('', merged.body);
					const metadataDiff = this.createObjectPatch({}, merged.metadata);
					queries.push(kysely.updateTable('revisions')
						.set({ title_diff: titleDiff, body_diff: bodyDiff, metadata_diff: metadataDiff, updated_time: time.unixMs(), parent_id: '' })
						.where('id', '=', keptRev.id));
				}
			}

			await this.batchDelete(oldRevisions.map(item => item.id), { sourceDescription: 'Revision.deleteOldRevisions' });
			if (queries.length) {
				await this.db().transactionExecBatch(queries);
			}
		};

		for (const [itemId, oldRevisions] of itemIdToOldRevisions.entries()) {
			if (!oldRevisions.length) {
				throw new Error('Invalid state: There must be at least one old revision per item to be processed.');
			}

			const latestOldRevision = oldRevisions[oldRevisions.length - 1];

			try {
				await deleteOldRevisionsForItem(latestOldRevision.item_type, itemId, oldRevisions);
			} catch (error) {
				if (error.code === 'revision_encrypted') {
					this.logger().info(`Aborted deletion of old revisions for item "${itemId}" (latest old rev "${latestOldRevision.id}") because one of the revisions is still encrypted`, error);
				} else {
					throw error;
				}
			}
		}
	}

	public static async deleteHistoryForNote(noteIds: string | string[], options: DeleteOptions) {
		const ids = Array.isArray(noteIds) ? noteIds : [noteIds];

		const revisions: RevisionEntity[] = await this.modelSelectAll(
			kysely.selectFrom('revisions').select('id').where('item_type', '=', ModelType.Note).where('item_id', 'in', literalList(ids)).orderBy('item_updated_time', 'desc'),
		);

		await this.batchDelete(revisions.map(item => item.id), options);
	}

	// Same as deleteHistoryForNote, but keeps locked revisions when clearing plaintext history during note locking.
	public static async deleteUnencryptedHistoryForNote(noteIds: string | string[], options: DeleteOptions) {
		const ids = Array.isArray(noteIds) ? noteIds : [noteIds];

		const revisions: RevisionEntity[] = await this.modelSelectAll(
			kysely.selectFrom('revisions').select('id').where('item_type', '=', ModelType.Note).where('item_id', 'in', literalList(ids)).where('is_locked', '=', 0).orderBy('item_updated_time', 'desc'),
		);

		await this.batchDelete(revisions.map(item => item.id), options);
	}

	public static async revisionExists(itemType: ModelType, itemId: string, updatedTime: number) {
		const existingRev = await Revision.latestRevision(itemType, itemId);
		return existingRev && existingRev.item_updated_time === updatedTime;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- patchArray items have a diff-match-patch shape (.diffs as [number, string][]); no installed @types/diff-match-patch
	private static parsePatch(patch: string): any[] {
		return patch ? JSON.parse(patch) : [];
	}

}
