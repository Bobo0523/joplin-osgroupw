import { setupDatabaseAndSynchronizer, db, switchClient, supportDir } from '../../testing/test-utils';
import SearchEngine from './SearchEngine';
import Note from '../../models/Note';
import Folder from '../../models/Folder';
import Tag from '../../models/Tag';
import shim from '../../shim';
import ResourceService from '../ResourceService';

// Captures the search results for a set of filter combinations, so that the
// queries built by queryBuilder can be rewritten without changing behaviour.
// This deliberately includes combinations that may currently give surprising
// results - the goal is to preserve them, not to judge them.

let engine: SearchEngine = null;

const queries = [
	'hello',
	'hello world',
	'-hello',
	'title:hello',
	'body:world',
	'-title:hello',
	'-body:world',
	'any:1 hello banana',
	'any:1 -hello -banana',
	'any:1 -title:hello',
	'notebook:Work',
	'-notebook:Work',
	'notebook:Wor*',
	'notebook:Work hello',
	'notebook:Work any:1 tag:red tag:blue',
	'notebook:Work any:1 banana',
	'tag:red',
	'tag:red tag:blue',
	'-tag:red',
	'any:1 tag:red tag:blue',
	'any:1 -tag:red -tag:blue',
	'tag:r*',
	'resource:image/png',
	'resource:image/jpeg',
	'-resource:image/png',
	'resource:image/*',
	'any:1 resource:image/png tag:blue',
	'type:todo',
	'type:note',
	'iscompleted:1',
	'iscompleted:0',
	'any:1 type:todo iscompleted:1',
	'created:20200101',
	'updated:19990101',
	'-updated:20300101',
	'due:20200101',
	'-due:20300101',
	'latitude:10',
	'-longitude:20',
	'altitude:5',
	'sourceurl:https://example.com*',
	'-sourceurl:https://example.com*',
	'id:{NOTE1}',
	'-id:{NOTE1}',
	'id:{NOTE1} notebook:Work',
	'id:{NOTE1} tag:red',
	'id:{NOTE1} resource:image/png',
	'id:{NOTE1} hello',
	'any:1 id:{NOTE1} id:{NOTE2}',
	'notebook:Work tag:red hello',
	'notebook:Work -notebook:Sub tag:blue',
];

const searchTypes = [SearchEngine.SEARCH_TYPE_FTS, SearchEngine.SEARCH_TYPE_NONLATIN_SCRIPT];

describe('services/search/queryBuilder', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);

		engine = new SearchEngine();
		engine.setDb(db());
	});

	test('should return the same results for every filter combination', async () => {
		const work = await Folder.save({ title: 'Work' });
		const sub = await Folder.save({ title: 'Sub', parent_id: work.id });
		const home = await Folder.save({ title: 'Home' });

		const created = new Date(2020, 0, 2).getTime();
		const note1 = await Note.save({ title: 'hello world', body: 'banana', parent_id: work.id, created_time: created, updated_time: created, user_created_time: created, user_updated_time: created, latitude: 15, longitude: 25, altitude: 6, source_url: 'https://example.com/a' }, { autoTimestamp: false });
		const note2 = await Note.save({ title: 'hello', body: 'world', parent_id: sub.id, is_todo: 1, todo_due: new Date(2020, 0, 5).getTime(), todo_completed: 1234, created_time: created, updated_time: created, user_created_time: created - 1000000000, user_updated_time: created }, { autoTimestamp: false });
		const note3 = await Note.save({ title: 'banana split', body: 'dessert', parent_id: home.id, is_todo: 1, latitude: 5, longitude: 10, altitude: 1, source_url: 'https://other.org' });
		const note4 = await Note.save({ title: 'misc', body: 'hello there', parent_id: home.id });
		await Note.save({ title: 'cherry', body: 'world', parent_id: sub.id });

		const red = await Tag.save({ title: 'red' });
		const blue = await Tag.save({ title: 'blue' });
		await Tag.addNote(red.id, note1.id);
		await Tag.addNote(blue.id, note1.id);
		await Tag.addNote(red.id, note3.id);
		await Tag.addNote(blue.id, note4.id);

		await shim.attachFileToNote(note1, `${supportDir}/photo.jpg`);
		await shim.attachFileToNote(note2, `${supportDir}/welcome.pdf`);
		await shim.attachFileToNote(note4, `${supportDir}/photo.jpg`);
		const pngNote = await Note.save({ title: 'png note', parent_id: work.id });
		await shim.attachFileToNote(pngNote, `${supportDir}/photo-large.png`);
		await (new ResourceService()).indexNoteResources();

		await engine.syncTables();

		const noteNames = new Map<string, string>();
		for (const n of await Note.all()) noteNames.set(n.id, n.title);

		const output: Record<string, Record<string, string[] | string>> = {};
		for (const query of queries) {
			const resolvedQuery = query.replace('{NOTE1}', note1.id).replace('{NOTE2}', note2.id);
			output[query] = {};
			for (const searchType of searchTypes) {
				try {
					const rows = await engine.search(resolvedQuery, { searchType });
					output[query][searchType] = rows.map(r => noteNames.get(r.id) ?? r.id).sort();
				} catch (error) {
					output[query][searchType] = `Error: ${error.message.split(':')[0]}`;
				}
			}
		}

		expect(output).toMatchSnapshot();
	});

});
