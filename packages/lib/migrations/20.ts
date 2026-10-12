import Resource from '../models/Resource';
import Setting from '../models/Setting';
import shim from '../shim';
import { reg } from '../registry';
import { fileExtension } from '../path-utils';
import { QueryInput } from '../database';
import { kysely } from '../services/database/kysely';

interface Script {
	exec: ()=> Promise<void>;
}

const script: Script = <Script>{};

script.exec = async () => {
	const stats = await shim.fsDriver().readDirStats(Setting.value('resourceDir'));

	let queries: QueryInput[] = [];
	for (const stat of stats) {
		if (fileExtension(stat.path) === 'crypted') continue;
		const resourceId = Resource.pathToId(stat.path);
		if (!resourceId) continue;

		queries.push(kysely.updateTable('resources').set({ size: stat.size }).where('id', '=', resourceId));

		if (queries.length >= 1000) {
			await reg.db().transactionExecBatch(queries);
			queries = [];
		}
	}

	await reg.db().transactionExecBatch(queries);
};

export default script;
