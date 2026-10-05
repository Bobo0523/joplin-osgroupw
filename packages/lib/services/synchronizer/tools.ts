import JoplinDatabase from '../../JoplinDatabase';
import BaseItem from '../../models/BaseItem';
import Setting from '../../models/Setting';
import SyncTargetRegistry from '../../SyncTargetRegistry';
import { dynamicQb, qb, Query } from '../database/kysely';

async function clearSyncContext() {
	const syncTargetIds = SyncTargetRegistry.allIds();

	for (const syncTargetId of syncTargetIds) {
		const key = `sync.${syncTargetId}.context`;
		if (Setting.keyExists(key)) {
			Setting.resetKey(key);
		}
	}

	await Setting.saveAll();
}

export async function clearLocalSyncStateForReupload(db: JoplinDatabase) {
	const queries: Query[] = [
		qb.deleteFrom('deleted_items'),
		qb.deleteFrom('sync_items'),
	];

	await db.transactionExecBatch(queries);

	await clearSyncContext();
}

export async function clearLocalDataForRedownload(db: JoplinDatabase) {
	const queries: Query[] = [
		qb.deleteFrom('deleted_items'),
		qb.deleteFrom('sync_items'),
		qb.deleteFrom('item_changes'),
		qb.deleteFrom('note_resources'),
	];

	const syncItemTypes = BaseItem.syncItemTypes();

	for (const syncItemType of syncItemTypes) {
		const SyncItemClass = BaseItem.getClassByItemType(syncItemType);
		queries.push(dynamicQb.deleteFrom(SyncItemClass.tableName()));
	}

	await db.transactionExecBatch(queries);

	await clearSyncContext();
}
