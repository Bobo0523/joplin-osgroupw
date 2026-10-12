import { setupDatabaseAndSynchronizer, switchClient, db } from '../../testing/test-utils';
import { insertInto, kysely, toSqlQuery } from './kysely';
import { legacyFragment } from './sqlFragments';

describe('services/database/kysely', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	test('should run Kysely queries through the Joplin database', async () => {
		await db().exec(insertInto('key_values', { key: 'a', value: '1', type: 1, updated_time: 10 }));
		await db().transactionExecBatch([
			insertInto('key_values', { key: 'b', value: '2', type: 1, updated_time: 20 }),
			kysely.updateTable('key_values').set({ value: '3' }).where('key', '=', 'a'),
		]);

		const rows = await db().selectAll(kysely.selectFrom('key_values').select(['key', 'value']).orderBy('key'));
		expect(rows).toEqual([{ key: 'a', value: '3' }, { key: 'b', value: '2' }]);

		const row = await db().selectOne(kysely.selectFrom('key_values').select('value').where(legacyFragment<boolean>('`key` = ? AND updated_time > ?', ['b', 15])));
		expect(row).toEqual({ value: '2' });
	});

	test('should convert a Kysely query to a Joplin query', () => {
		expect(toSqlQuery(kysely.selectFrom('notes').select('id').where('is_todo', '=', 1).limit(2))).toEqual({
			sql: 'select "id" from "notes" where "is_todo" = ? limit ?',
			params: [1, 2],
		});
	});

});
