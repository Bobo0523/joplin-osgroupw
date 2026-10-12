import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';
import Folder from './Folder';
import Note, { PreviewsOptions } from './Note';
import { NoteEntity } from '../services/database/types';
import { ALL_NOTES_FILTER_ID } from '../reserved-ids';
import { getTrashFolderId } from '../services/trash';
import getConflictFolderId from './utils/getConflictFolderId';

interface Fixture {
	folder1Id: string;
	ids: Record<string, string>;
}

const saveNote = async (props: NoteEntity, time: number) => {
	return Note.save({ created_time: time, updated_time: time, user_created_time: time, user_updated_time: time, ...props }, { autoTimestamp: false });
};

const setupFixture = async (): Promise<Fixture> => {
	const folder1 = await Folder.save({ title: 'folder1' });
	const folder2 = await Folder.save({ title: 'folder2' });

	const ids: Record<string, string> = {};
	ids.alpha = (await saveNote({ title: 'Alpha', parent_id: folder1.id }, 1000)).id;
	ids.beta = (await saveNote({ title: 'beta', parent_id: folder1.id, is_todo: 1 }, 2000)).id;
	ids.gamma = (await saveNote({ title: 'Gamma', parent_id: folder1.id, is_todo: 1, todo_completed: 5000 }, 3000)).id;
	ids.delta = (await saveNote({ title: 'delta', body: 'hello world', parent_id: folder1.id }, 4000)).id;
	ids.conflict = (await saveNote({ title: 'conflict', parent_id: folder1.id, is_conflict: 1 }, 6000)).id;
	ids.other = (await saveNote({ title: 'other', parent_id: folder2.id }, 5000)).id;

	return { folder1Id: folder1.id, ids };
};

describe('Note.previews', () => {

	let fixture: Fixture;

	const names = (notes: NoteEntity[]) => notes.map(n => Object.keys(fixture.ids).find(k => fixture.ids[k] === n.id));

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		fixture = await setupFixture();
	});

	test.each<[string, PreviewsOptions, string[]]>([
		['default order', {}, ['delta', 'gamma', 'beta', 'alpha']],
		['uncompleted todos on top', { uncompletedTodosOnTop: true }, ['beta', 'delta', 'gamma', 'alpha']],
		['hide completed todos', { showCompletedTodos: false }, ['delta', 'beta', 'alpha']],
		['notes only', { itemTypes: ['note'] }, ['delta', 'alpha']],
		['todos only', { itemTypes: ['todo'] }, ['gamma', 'beta']],
		['todos only with uncompleted on top', { itemTypes: ['todo'], uncompletedTodosOnTop: true }, ['beta', 'gamma']],
		['title natural order ascending', { order: [{ by: 'title', dir: 'ASC' }] }, ['alpha', 'beta', 'delta', 'gamma']],
		['title natural order descending', { order: [{ by: 'title', dir: 'DESC' }] }, ['gamma', 'delta', 'beta', 'alpha']],
		['created time ascending', { order: [{ by: 'user_created_time', dir: 'ASC' }] }, ['alpha', 'beta', 'gamma', 'delta']],
		['limit', { limit: 2 }, ['delta', 'gamma']],
		['limit with uncompleted todos on top', { limit: 2, uncompletedTodosOnTop: true }, ['beta', 'delta']],
		['conditions with params', { conditions: ['is_todo = ?'], conditionsParams: [1] }, ['gamma', 'beta']],
		['title pattern', { titlePattern: 'Al*' }, ['alpha']],
		['anywhere pattern in body', { anywherePattern: '*world*' }, ['delta']],
		['anywhere pattern in title', { anywherePattern: '*amm*' }, ['gamma']],
	])('should list notes in a folder: %s', async (_label, options, expected) => {
		const notes = await Note.previews(fixture.folder1Id, options);
		expect(names(notes)).toEqual(expected);
	});

	test('should list notes in all folders', async () => {
		const notes = await Note.previews(ALL_NOTES_FILTER_ID);
		expect(names(notes)).toEqual(['other', 'delta', 'gamma', 'beta', 'alpha']);
	});

	test('should list only conflicts in the conflict folder', async () => {
		const notes = await Note.previews(getConflictFolderId());
		expect(names(notes)).toEqual(['conflict']);
	});

	test('should list deleted notes only in the trash', async () => {
		await Note.delete(fixture.ids.beta, { toTrash: true });
		expect(names(await Note.previews(fixture.folder1Id))).toEqual(['delta', 'gamma', 'alpha']);
		expect(names(await Note.previews(getTrashFolderId()))).toEqual(['beta']);
	});

	test('should not return fields that were only added internally', async () => {
		const notes = await Note.previews(fixture.folder1Id, { fields: ['title'] });
		expect(notes.map(n => n.title)).toEqual(['delta', 'Gamma', 'beta', 'Alpha']);
		for (const note of notes) {
			expect('id' in note).toBe(false);
			expect('parent_id' in note).toBe(false);
			expect('deleted_time' in note).toBe(false);
		}
	});

});
