import { setupDatabaseAndSynchronizer, switchClient, db } from '../../testing/test-utils';
import Note from '../Note';
import Folder from '../Folder';
import Tag from '../Tag';
import paginatedFeed from './paginatedFeed';
import { PaginationOrderDir } from './types';
import { NoteEntity } from '../../services/database/types';

// Captures how the shared model query options (where, conditions, order,
// limit, fields, patterns, pagination) behave, so that the SQL behind them can
// be rewritten without changing results. Some cases capture existing quirks
// on purpose, such as loadByFields() only applying the case-insensitive
// comparison to the last field.

const titles = (notes: NoteEntity[]) => notes.map(n => n.title);

describe('models/utils/queryOptions', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	test('should apply the shared query options in the same way', async () => {
		const folder1 = await Folder.save({ title: 'Work' });
		const folder2 = await Folder.save({ title: 'work notes' });
		await Folder.save({ title: 'Home' });

		// Fixed IDs, because some of the results are ordered by ID
		let time = 1000;
		let idCounter = 0;
		const save = async (note: NoteEntity) => {
			time += 1000;
			idCounter++;
			const id = idCounter.toString(16).padStart(32, '0');
			return Note.save({ id, parent_id: folder1.id, user_created_time: time, user_updated_time: time, created_time: time, updated_time: time, ...note }, { autoTimestamp: false, isNew: true });
		};

		const apple = await save({ title: 'apple', body: 'red fruit' });
		await save({ title: 'Banana', body: 'yellow' });
		await save({ title: 'cherry', body: 'Red' });
		await save({ title: 'note 10', body: '' });
		await save({ title: 'note 9', body: '' });
		await save({ title: 'todo open', is_todo: 1 });
		await save({ title: 'todo done', is_todo: 1, todo_completed: 5000 });
		await save({ title: 'other folder', parent_id: folder2.id });
		await save({ title: 'Apple', body: 'other', parent_id: folder2.id });

		const tag = await Tag.save({ title: 'fruit' });
		await Tag.addNote(tag.id, apple.id);

		const allNotes = await Note.all();
		const byTitle = (title: string) => allNotes.find(n => n.title === title);

		const output: Record<string, unknown> = {
			allWhere: titles(await Note.all({ where: 'title LIKE ? OR body LIKE ?', whereParams: ['%e%', '%red%'], order: [{ by: 'title', dir: 'ASC' }], limit: 4, fields: ['id', 'title'] })),
			allOrderCaseInsensitive: titles(await Note.all({ order: [{ by: 'title', dir: 'DESC', caseInsensitive: true }], fields: ['title'] })),
			allGlobalCaseInsensitive: titles(await Note.all({ order: [{ by: 'title', dir: 'ASC' }], caseInsensitive: true, fields: ['title'] })),
			allFieldsOnly: Object.keys((await Note.all({ fields: ['id', 'title'], limit: 1 }))[0]).sort(),
			allIds: (await Note.allIds({ order: [{ by: 'user_created_time', dir: 'DESC' }], limit: 3 })).map(id => allNotes.find(n => n.id === id).title),
			byIds: titles(await Note.byIds([byTitle('cherry').id, apple.id, byTitle('Banana').id], { fields: ['title'], order: [{ by: 'title', dir: 'ASC' }] })),
			byIdsEmpty: await Note.byIds([]),
			searchTitlePattern: titles(await Note.search({ titlePattern: 'note*', order: [{ by: 'title', dir: 'ASC' }] })),
			searchConditions: titles(await Note.search({ conditions: ['is_todo = ?', 'parent_id = ?'], conditionsParams: [1, folder1.id], fields: ['title'], order: [{ by: 'title', dir: 'ASC' }] })),
			searchBodyPattern: titles(await Note.search({ bodyPattern: '*red*', order: [{ by: 'title', dir: 'ASC' }] })),
			searchZeroLimit: await Note.search({ limit: 0 }),
			folderSearch: (await Folder.search({ titlePattern: 'w*', order: [{ by: 'title', dir: 'ASC' }] })).map(f => f.title),
			count: await Note.count(),
			countWhere: await Note.count({ where: 'is_todo = 1' }),
			loadByPartialId: titles(await Note.loadByPartialId(apple.id.substr(0, 10))),
			loadByField: (await Note.loadByField('title', 'BANANA', { caseInsensitive: true }))?.title ?? null,
			loadByFieldCaseSensitive: (await Note.loadByField('title', 'BANANA'))?.title ?? null,
			loadByFieldsFirstFieldCase: (await Note.loadByFields({ title: 'CHERRY', body: 'Red' }, { caseInsensitive: true }))?.title ?? null,
			loadByFieldsLastFieldCase: (await Note.loadByFields({ title: 'cherry', body: 'RED' }, { caseInsensitive: true }))?.title ?? null,
			loadByTitle: (await Note.loadByTitle('cherry'))?.title ?? null,
			previewsDefault: titles(await Note.previews(folder1.id)),
			previewsOrderTitle: titles(await Note.previews(folder1.id, { order: [{ by: 'title', dir: 'ASC' }] })),
			previewsTodosOnTop: titles(await Note.previews(folder1.id, { uncompletedTodosOnTop: true, order: [{ by: 'title', dir: 'ASC' }] })),
			previewsTodosOnTopLimit: titles(await Note.previews(folder1.id, { uncompletedTodosOnTop: true, order: [{ by: 'title', dir: 'ASC' }], limit: 3 })),
			previewsHideCompleted: titles(await Note.previews(folder1.id, { showCompletedTodos: false, order: [{ by: 'title', dir: 'ASC' }] })),
			previewsItemTypes: titles(await Note.previews(folder1.id, { itemTypes: ['todo'], order: [{ by: 'title', dir: 'ASC' }] })),
			previewsAnywhere: titles(await Note.previews(null, { anywherePattern: '*red*', order: [{ by: 'title', dir: 'ASC' }] })),
			previewsTitlePattern: titles(await Note.previews('', { titlePattern: 'a*', order: [{ by: 'title', dir: 'ASC' }] })),
			previewsConditions: titles(await Note.previews(null, { conditions: [`id IN ('${apple.id}', '${byTitle('Apple').id}')`], order: [] })),
			previewsFields: Object.keys((await Note.previews(folder1.id, { fields: ['title'], limit: 1 }))[0]).sort(),
			tagNotes: (await Tag.notes(tag.id)).map(n => n.title),
		};

		const feedOrder = [{ by: 'title', dir: PaginationOrderDir.ASC, caseInsensitive: true }];
		const page1 = await paginatedFeed(db(), 'notes', { page: 1, limit: 3, order: feedOrder }, { sql: 'is_todo = ?', params: [0] }, ['title']);
		const page2 = await paginatedFeed(db(), 'notes', { page: 2, limit: 3, order: feedOrder }, { sql: 'is_todo = ?', params: [0] }, ['title']);
		const pageAll = await paginatedFeed(db(), 'notes', { page: 1, limit: 100, order: [{ by: 'user_updated_time', dir: PaginationOrderDir.DESC, caseInsensitive: false }] });
		output.paginatedFeed = {
			page1: { items: titles(page1.items), has_more: page1.has_more },
			page2: { items: titles(page2.items), has_more: page2.has_more },
			pageAllKeys: Object.keys(pageAll.items[0]).sort(),
			pageAllCount: pageAll.items.length,
		};

		expect(output).toMatchSnapshot();
	});

});
