import { db, setupDatabaseAndSynchronizer, switchClient } from '../../testing/test-utils';
import { insertRow, kysely, toSqlQuery } from './kysely';
import { rawFragment } from './sqlFragments';

describe('kysely', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('should run Kysely queries through the Database class', async () => {
		await db().exec(kysely.insertInto('key_values').values(insertRow('key_values', { key: 'k1', value: 'v1', type: 1, updated_time: 1 })));
		await db().exec(kysely.updateTable('key_values').set({ value: 'v2' }).where('key', '=', 'k1'));
		const row = await db().selectOne(kysely.selectFrom('key_values').select(['key', 'value']).where('key', '=', 'k1'));
		expect(row).toEqual({ key: 'k1', value: 'v2' });

		await db().transactionExecBatch([
			kysely.insertInto('key_values').values(insertRow('key_values', { key: 'k2', value: 'v', type: 1, updated_time: 1 })),
			kysely.deleteFrom('key_values').where('key', '=', 'k1'),
		]);
		const rows = await db().selectAll(kysely.selectFrom('key_values').select('key').where(rawFragment('`key` LIKE ?', ['k%'])));
		expect(rows.map(r => r.key)).toEqual(['k2']);
	});

	it('should convert booleans to integers and keep raw fragment parameters', () => {
		const query = toSqlQuery(kysely.selectFrom('notes').select('id').where('is_todo', '=', true as unknown as number).where(rawFragment('title = ? OR body = \'?\'', ['a'])));
		expect(query.params).toEqual([1, 'a']);
		expect(query.sql).toContain('body = \'?\'');
	});

});
