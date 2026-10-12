import { setupDatabaseAndSynchronizer, switchClient } from './testing/test-utils';
import Folder from './models/Folder';
import Note from './models/Note';
import { LoadOptions } from './models/utils/types';
import { SearchOptions } from './BaseModel';
import { NoteEntity } from './services/database/types';

describe('BaseModel.options', () => {

	let ids: Record<string, string>;

	const names = (notes: NoteEntity[]) => notes.map(n => Object.keys(ids).find(k => ids[k] === n.id));

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		const folder = await Folder.save({ title: 'folder' });
		ids = {
			apple: (await Note.save({ title: 'apple', body: 'Red', parent_id: folder.id })).id,
			banana: (await Note.save({ title: 'Banana', body: 'Yellow', parent_id: folder.id })).id,
			cherry: (await Note.save({ title: 'cherry', body: 'red', parent_id: folder.id, is_todo: 1 })).id,
		};
	});

	test.each<[string, LoadOptions, string[]]>([
		['order is case sensitive by default', { order: [{ by: 'title', dir: 'ASC' }] }, ['banana', 'apple', 'cherry']],
		['order item can be case insensitive', { order: [{ by: 'title', dir: 'ASC', caseInsensitive: true }] }, ['apple', 'banana', 'cherry']],
		['caseInsensitive option applies to every order item', { order: [{ by: 'title', dir: 'DESC' }], caseInsensitive: true }, ['cherry', 'banana', 'apple']],
		['where with params', { where: 'body LIKE ?', whereParams: ['red'], order: [{ by: 'title', dir: 'ASC' }] }, ['apple', 'cherry']],
		['where without params', { where: 'is_todo = 1' }, ['cherry']],
		['limit', { order: [{ by: 'title', dir: 'DESC' }], limit: 2 }, ['cherry', 'apple']],
	])('all: %s', async (_label, options, expected) => {
		expect(names(await Note.all(options))).toEqual(expected);
	});

	test('all should only return the requested fields', async () => {
		const notes = await Note.all({ fields: ['id', 'title'], order: [{ by: 'title', dir: 'ASC' }] });
		expect(notes.map(n => Object.keys(n).sort())).toEqual([['id', 'title', 'type_'], ['id', 'title', 'type_'], ['id', 'title', 'type_']]);
	});

	test('allIds should apply order and limit', async () => {
		const result = await Note.allIds({ order: [{ by: 'title', dir: 'ASC', caseInsensitive: true }], limit: 2 });
		expect(result).toEqual([ids.apple, ids.banana]);
	});

	test.each<[string, SearchOptions, string[]]>([
		['conditions with params', { conditions: ['body = ?', 'is_todo = ?'], conditionsParams: ['red', 1] }, ['cherry']],
		['title pattern with wildcard', { titlePattern: '*an*' }, ['banana']],
		['title pattern combined with conditions', { conditions: ['is_todo = ?'], conditionsParams: [0], titlePattern: '*e*', order: [{ by: 'title', dir: 'ASC' }] }, ['apple']],
		['order and limit', { order: [{ by: 'title', dir: 'DESC' }], limit: 1 }, ['cherry']],
		['limit of zero', { limit: 0 }, []],
	])('search: %s', async (_label, options, expected) => {
		expect(names(await Note.search(options))).toEqual(expected);
	});

	test('byIds should apply options and handle empty input', async () => {
		expect(await Note.byIds([])).toEqual([]);
		const notes = await Note.byIds([ids.apple, ids.cherry, 'unknown'], { order: [{ by: 'title', dir: 'DESC' }], fields: ['id'] });
		expect(names(notes)).toEqual(['cherry', 'apple']);
		expect(Object.keys(notes[0]).sort()).toEqual(['id', 'type_']);
	});

	test('loadByField should support case insensitive lookup', async () => {
		expect(await Note.loadByField('title', 'APPLE')).toBeFalsy();
		expect((await Note.loadByField('title', 'APPLE', { caseInsensitive: true })).id).toBe(ids.apple);
	});

	// Quirk: COLLATE NOCASE is appended after the whole WHERE clause, so only
	// the last field is compared case-insensitively.
	test.each<[Record<string, string>, boolean, string | null]>([
		[{ title: 'apple', body: 'Red' }, false, 'apple'],
		[{ title: 'apple', body: 'red' }, false, null],
		[{ title: 'apple', body: 'RED' }, true, 'apple'],
		[{ title: 'APPLE', body: 'Red' }, true, null],
	])('loadByFields(%j, caseInsensitive: %s)', async (fields, caseInsensitive, expected) => {
		const note: NoteEntity = await Note.loadByFields(fields, { caseInsensitive });
		expect(note ? names([note])[0] : null).toBe(expected);
	});

	test('count should support a where clause', async () => {
		expect(await Note.count()).toBe(3);
		expect(await Note.count({ where: 'is_todo = 0' })).toBe(2);
	});

});
