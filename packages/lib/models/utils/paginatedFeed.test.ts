import { db, setupDatabaseAndSynchronizer, switchClient } from '../../testing/test-utils';
import Tag from '../Tag';
import paginatedFeed, { WhereQuery } from './paginatedFeed';
import paginationToOrderBy from './paginationToSql';
import { kysely, toSqlQuery } from '../../services/database/kysely';
import { Pagination, PaginationOrderDir } from './types';

const titleOrder = (dir: PaginationOrderDir, caseInsensitive = false) => ({ by: 'title', dir, caseInsensitive });

const orderBySql = (pagination: Pagination) => {
	let query = kysely.selectFrom('tags').select('id');
	for (const orderBy of paginationToOrderBy(pagination)) query = query.orderBy(orderBy);
	return toSqlQuery(query).sql.replace(/^.* order by /, '');
};

describe('paginatedFeed', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		for (const title of ['b', 'a', 'd', 'c', 'e']) await Tag.save({ title });
	});

	test.each<[Pagination, string]>([
		[{ limit: 10, page: 1, order: [titleOrder(PaginationOrderDir.ASC)] }, '"title" ASC'],
		[{ limit: 10, page: 1, order: [titleOrder(PaginationOrderDir.DESC, true)] }, '"title" COLLATE NOCASE DESC'],
		[{ limit: 10, page: 1, order: [titleOrder(PaginationOrderDir.ASC), { by: 'id', dir: PaginationOrderDir.DESC, caseInsensitive: false }] }, '"title" ASC, "id" DESC'],
		[{ limit: 10, page: 1, caseInsensitive: true, order: [titleOrder(PaginationOrderDir.ASC), { by: 'id', dir: PaginationOrderDir.ASC, caseInsensitive: false }] }, '"title" COLLATE NOCASE ASC, "id" COLLATE NOCASE ASC'],
	])('paginationToOrderBy should convert %j', (pagination, expected) => {
		expect(orderBySql(pagination)).toBe(expected);
	});

	test.each<[number, number, PaginationOrderDir, string[], boolean]>([
		[2, 1, PaginationOrderDir.ASC, ['a', 'b'], true],
		[2, 2, PaginationOrderDir.ASC, ['c', 'd'], true],
		[2, 3, PaginationOrderDir.ASC, ['e'], false],
		[2, 1, PaginationOrderDir.DESC, ['e', 'd'], true],
		// Quirk: has_more is true when the last page is exactly full
		[5, 1, PaginationOrderDir.ASC, ['a', 'b', 'c', 'd', 'e'], true],
		[5, 2, PaginationOrderDir.ASC, [], false],
	])('should paginate with limit %d, page %d, %s', async (limit, page, dir, expectedTitles, expectedHasMore) => {
		const result = await paginatedFeed(db(), 'tags', { limit, page, order: [titleOrder(dir)] }, null, ['title']);
		expect(result.items.map(i => i.title)).toEqual(expectedTitles);
		expect(result.has_more).toBe(expectedHasMore);
		expect(result.total).toBeUndefined();
	});

	test('should apply the where query and default to the id field', async () => {
		const whereQuery: WhereQuery = { sql: 'title != ? AND title != ?', params: ['a', 'e'] };
		const result = await paginatedFeed(db(), 'tags', { limit: 10, page: 1, order: [titleOrder(PaginationOrderDir.ASC)] }, whereQuery);
		const allTags = await Tag.all({ order: [{ by: 'title', dir: 'ASC' }] });
		expect(result.items).toEqual(allTags.filter(t => t.title !== 'a' && t.title !== 'e').map(t => ({ id: t.id })));
	});

	test('should return only the requested fields', async () => {
		const result = await paginatedFeed(db(), 'tags', { limit: 1, page: 1, order: [titleOrder(PaginationOrderDir.ASC)] }, null, ['title', 'id']);
		expect(Object.keys(result.items[0]).sort()).toEqual(['id', 'title']);
	});

	test.each<[Pagination, string]>([
		[{ limit: 10, page: 1, order: [] }, 'Pagination order must be provided'],
		[{ limit: 10, page: 1, order: [titleOrder(PaginationOrderDir.ASC), titleOrder(PaginationOrderDir.DESC)] }, 'Only one pagination order field can be provided'],
	])('should reject invalid order %j', async (pagination, message) => {
		await expect(paginatedFeed(db(), 'tags', pagination)).rejects.toThrow(message);
	});

});
