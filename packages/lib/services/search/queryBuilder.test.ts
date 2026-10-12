import filterParser from './filterParser';
import queryBuilder from './queryBuilder';

// Date params depend on the local time zone, so timestamps are replaced.
const normaliseParams = (params: (string | number)[]) => params.map(p => /^\d{10,}$/.test(`${p}`) ? '<timestamp>' : p);

const build = (searchString: string, useFts: boolean) => {
	const { query, params } = queryBuilder(filterParser(searchString), useFts);
	return { query: query.replace(/\s+/g, ' ').trim(), params: normaliseParams(params) };
};

describe('queryBuilder', () => {

	test.each([
		['id:abc notebook:nb1'],
		['id:abc tag:tag1'],
		['id:abc resource:image/png'],
		['id:abc notebook:nb1 tag:tag1 resource:image/*'],
		['any:1 id:abc notebook:nb1 tag:tag1'],
		['any:1 id:abc -tag:tag1 -resource:image/png'],
		['-id:abc -notebook:nb1 -tag:tag1 -resource:application/pdf'],
		['tag:t1 tag:t2 -tag:t3'],
		['any:1 tag:t1 tag:t2 -tag:t3'],
		['notebook:nb1 notebook:nb2 -notebook:nb3 hello'],
		['any:1 notebook:nb1 hello world'],
		['created:20200101 -updated:202001 due:2020'],
		['any:1 created:20200101 -due:20200102'],
		['type:todo iscompleted:1'],
		['any:1 type:note iscompleted:0'],
		['latitude:10 -longitude:20 altitude:30'],
		['sourceurl:https://example.com/* -sourceurl:*.org'],
		['hel* "exact phrase" -excluded'],
		['title:hello body:world* -title:bye'],
		['any:1 title:hello body:world'],
	])('should build query for %s', (searchString) => {
		expect({
			fts: build(searchString, true),
			noFts: build(searchString, false),
		}).toMatchSnapshot();
	});

	// Quirk: the id: parameter is pushed before the notebook/tag/resource
	// parameters, although the WITH clauses holding those placeholders come
	// first in the SQL text.
	test.each([
		['id:abc notebook:nb1', ['abc', 'nb1']],
		['id:abc tag:tag1', ['abc', 'tag1']],
		['id:abc resource:image/png', ['abc', 'image/png']],
	])('should keep the current parameter order for %s', (searchString, expectedParams) => {
		const { query, params } = build(searchString, false);
		expect(params).toEqual(expectedParams);
		expect(query.startsWith('WITH RECURSIVE')).toBe(true);
		expect(query.indexOf('LIKE ?')).toBeLessThan(query.indexOf('id LIKE ?'));
	});

});
