import JoplinDatabase from '../../JoplinDatabase';
import BaseItem from '../../models/BaseItem';
import Setting from '../../models/Setting';
import SyncTargetRegistry from '../../SyncTargetRegistry';
import { QueryInput } from '../../database';
import { dynamicKysely, kysely } from '../database/kysely';

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
	const queries: QueryInput[] = [
		kysely.deleteFrom('deleted_items'),
		kysely.deleteFrom('sync_items'),
	];

	await db.transactionExecBatch(queries);

	await clearSyncContext();
}

export async function clearLocalDataForRedownload(db: JoplinDatabase) {
	const queries: QueryInput[] = [
		kysely.deleteFrom('deleted_items'),
		kysely.deleteFrom('sync_items'),
		kysely.deleteFrom('item_changes'),
		kysely.deleteFrom('note_resources'),
	];

	const syncItemTypes = BaseItem.syncItemTypes();

	for (const syncItemType of syncItemTypes) {
		const SyncItemClass = BaseItem.getClassByItemType(syncItemType);
		queries.push(dynamicKysely.deleteFrom(SyncItemClass.tableName()));
	}

	await db.transactionExecBatch(queries);

	await clearSyncContext();
}
