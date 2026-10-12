import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import JoplinDatabase, { unquoteDefaultValue } from '../../JoplinDatabase';
import { DatabaseDriverNode } from '../../database-driver-node';
import { tempFilePath } from '../../testing/test-utils';
import { SqlParams } from './types';
import { kysely } from './kysely';

// These tests lock down the schema produced by the upgrade steps in
// JoplinDatabase and services/database/migrations, at every version, so that
// any change to how the schema SQL is generated can be checked against the
// original. Set SCHEMA_FINGERPRINT_DUMP=<path> to write the full per-version
// fingerprints to a file when investigating a mismatch.

type Row = Record<string, unknown>;

class StopUpgradeError extends Error {}

interface QueryLike {
	sql?: string;
	params?: SqlParams;
	compile?: (executorProvider: unknown)=> { sql: string; parameters: readonly unknown[] };
}

const versionUpdateTarget = (queries: unknown[]): number | null => {
	for (const q of queries) {
		let sql = '';
		let params: readonly unknown[] = [];
		if (typeof q === 'string') {
			sql = q;
		} else if (q && typeof (q as QueryLike).compile === 'function') {
			// Raw statements written with the `sql` tag need the Kysely instance to compile
			const compiled = (q as QueryLike).compile(kysely);
			sql = compiled.sql;
			params = compiled.parameters;
		} else if (q) {
			sql = (q as QueryLike).sql;
			params = (q as QueryLike).params ?? [];
		}
		if (/^\s*update\s+[`"]?version[`"]?\s+set\s+[`"]?version[`"]?\s*=/i.test(sql)) return Number(params[0]);
	}
	return null;
};

// Runs the normal upgrade process, but refuses to go past `stopAfter`, which
// lets the test inspect the database at each intermediate version.
class SteppedDatabase extends JoplinDatabase {
	public stopAfter = Infinity;

	public override async transactionExecBatch(queries: Parameters<JoplinDatabase['transactionExecBatch']>[0]) {
		const target = versionUpdateTarget(queries);
		if (target !== null && target > this.stopAfter) throw new StopUpgradeError(`Stopped before version ${target}`);
		return super.transactionExecBatch(queries);
	}
}

const openDatabase = async (filePath: string, stopAfter = Infinity) => {
	const db = new SteppedDatabase(new DatabaseDriverNode());
	db.stopAfter = stopAfter;
	try {
		await db.open({ name: filePath });
	} catch (error) {
		if (!(error instanceof StopUpgradeError)) throw error;
	}
	return db;
};

const normalizeSql = (sql: unknown) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : sql;

// SQLite accepts both "..." and '...' for string literals in a DEFAULT clause,
// so only the kind of default (text or expression) and its value matter.
const normalizeDefault = (value: unknown) => {
	if (value === null || value === undefined) return null;
	const s = String(value);
	const match = /^(["'])([\s\S]*)\1$/.exec(s);
	if (match) return { text: match[2].split(match[1] + match[1]).join(match[1]) };
	return { expr: s };
};

// Views are compared by their SQL text, ignoring differences that don't change
// their meaning: letter case, identifier quotes, white space, and the
// optional AS keyword before a table alias ("note_tags nt" or "note_tags as nt").
const normalizeViewSql = (sql: unknown) => {
	return String(sql)
		.toLowerCase()
		.replace(/[`"]/g, '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([(),=<>])\s*/g, '$1')
		.replace(/\b(from|join) (\w+) as (\w+)\b/g, '$1 $2 $3')
		.trim();
};

const shadowTablePattern = /^(notes_fts|items_fts|search_aux|notes_spellfix|note_embeddings_vec).+/;

const schemaFingerprint = async (db: JoplinDatabase) => {
	const objects = await db.selectAll('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
	const output: Row = {};

	for (const o of objects) {
		const name = o.name as string;
		const sql = o.sql as string | null;
		const isVirtual = typeof sql === 'string' && /^\s*create\s+virtual\s+table/i.test(sql);
		const entry: Row = { type: o.type, tbl_name: o.tbl_name };

		if (o.type === 'table' && !isVirtual) {
			const columns = await db.selectAll(`PRAGMA table_xinfo("${name}")`);
			entry.columns = columns.map(c => ({
				name: c.name,
				type: String(c.type).toUpperCase(),
				notnull: c.notnull,
				default: normalizeDefault(c.dflt_value),
				pk: c.pk,
				hidden: c.hidden,
			}));
			entry.autoincrement = typeof sql === 'string' && /\bautoincrement\b/i.test(sql);
			const indexes = await db.selectAll(`PRAGMA index_list("${name}")`);
			entry.indexes = [];
			for (const index of indexes.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
				const indexColumns = await db.selectAll(`PRAGMA index_xinfo("${index.name}")`);
				(entry.indexes as Row[]).push({
					name: index.name,
					unique: index.unique,
					origin: index.origin,
					partial: index.partial,
					columns: indexColumns.filter(c => c.key).map(c => ({ name: c.name, desc: c.desc, coll: c.coll })),
				});
			}
			entry.foreignKeys = await db.selectAll(`PRAGMA foreign_key_list("${name}")`);
			entry.rowCount = (await db.selectOne(`SELECT count(*) AS total FROM "${name}"`)).total;
		} else if (o.type === 'view') {
			const columns = await db.selectAll(`PRAGMA table_info("${name}")`);
			entry.columns = columns.map(c => ({ name: c.name, type: String(c.type).toUpperCase() }));
			entry.sql = normalizeViewSql(sql);
		} else if (o.type === 'index') {
			// Covered by the table's index list.
			continue;
		} else {
			entry.sql = normalizeSql(sql);
		}

		if (shadowTablePattern.test(name) && o.type === 'table') delete entry.rowCount;

		output[`${o.type}:${name}`] = entry;
	}

	const tableNames = objects.filter(o => o.type === 'table').map(o => o.name);
	const data: Row = {};
	if (tableNames.includes('version')) data.version = await db.selectAll('SELECT * FROM version');
	if (tableNames.includes('migrations')) data.migrations = (await db.selectAll('SELECT number FROM migrations ORDER BY id')).map(r => r.number);
	if (tableNames.includes('table_fields')) data.tableFields = await db.selectAll('SELECT id, table_name, field_name, field_type, field_default FROM table_fields ORDER BY id');
	if (tableNames.includes('sqlite_sequence')) data.sqliteSequence = await db.selectAll('SELECT name, seq FROM sqlite_sequence ORDER BY name');

	return { objects: output, data };
};

const defaultRows = (db: JoplinDatabase) => {
	const output: Row = {};
	for (const tableName of ['notes', 'folders', 'tags', 'note_tags', 'resources', 'revisions', 'sync_items', 'item_changes', 'key_values', 'conflict_note_states']) {
		output[tableName] = db.createDefaultRow(tableName);
	}
	return output;
};

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const dumpRows = async (db: JoplinDatabase, sql: string) => db.selectAll(sql);

describe('database schema', () => {

	test('should produce the same schema at every version and for a fresh database', async () => {
		const filePath = tempFilePath('sqlite');
		const probe = await openDatabase(tempFilePath('sqlite'));
		const latestVersion = probe.version();
		await probe.close();

		const fingerprints: Row = {};
		const hashes: Record<number, string> = {};
		let db: SteppedDatabase = null;
		for (let version = 1; version <= latestVersion; version++) {
			db = await openDatabase(filePath, version);
			const fingerprint = await schemaFingerprint(db);
			fingerprints[version] = fingerprint;
			hashes[version] = hash(fingerprint);
			if (version < latestVersion) await db.close();
		}

		if (process.env.SCHEMA_FINGERPRINT_DUMP) writeFileSync(process.env.SCHEMA_FINGERPRINT_DUMP, JSON.stringify(fingerprints, null, '\t'));

		const steppedFinal = await schemaFingerprint(db);
		const steppedDefaults = defaultRows(db);
		await db.close();

		const fresh = await openDatabase(tempFilePath('sqlite'));
		const freshFinal = await schemaFingerprint(fresh);
		const freshDefaults = defaultRows(fresh);
		await fresh.close();

		expect(hashes).toMatchSnapshot();
		expect(freshFinal).toMatchSnapshot();
		expect(freshDefaults).toMatchSnapshot();
		expect(steppedFinal).toEqual(freshFinal);
		expect(steppedDefaults).toEqual(freshDefaults);
	}, 120000);

	// Databases created by the original upgrade steps have double-quoted string
	// defaults, and those created with the Kysely schema builder single-quoted ones.
	test.each([
		['""', ''],
		['"abc"', 'abc'],
		['"0"', '0'],
		['\'\'', ''],
		['\'it\'\'s\'', 'it\'s'],
		['\'2\'', '2'],
		['0', '0'],
		['-1', '-1'],
		[null, null],
	])('should read the default value %s as %s', (defaultValue, expected) => {
		expect(unquoteDefaultValue(defaultValue)).toBe(expected);
	});

	test('should migrate existing data the same way when upgrading an old database', async () => {
		const filePath = tempFilePath('sqlite');

		let db = await openDatabase(filePath, 2);
		await db.exec('INSERT INTO settings (`key`, `value`, `type`) VALUES (?, ?, ?)', ['sync.context', '{"a":1}', 2]);
		await db.exec('INSERT INTO settings (`key`, `value`, `type`) VALUES (?, ?, ?)', ['locale', 'fr_FR', 2]);
		await db.close();

		db = await openDatabase(filePath, 9);
		await db.exec('INSERT INTO folders (id, title, created_time, updated_time) VALUES (?, ?, ?, ?)', ['f1', 'Folder 1', 1000, 2000]);
		await db.exec('INSERT INTO notes (id, parent_id, title, body, created_time, updated_time, `order`, is_todo, encryption_applied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['n1', 'f1', 'Note 1', 'Body 1', 1000, 2000, 5, 1, 0]);
		await db.exec('INSERT INTO notes (id, parent_id, title, body, created_time, updated_time, is_conflict) VALUES (?, ?, ?, ?, ?, ?, ?)', ['n2', 'f1', 'Note 2', 'Body 2', 1500, 2500, 1]);
		await db.exec('INSERT INTO tags (id, title, created_time, updated_time) VALUES (?, ?, ?, ?)', ['t1', 'Tag 1', 1000, 2000]);
		await db.exec('INSERT INTO note_tags (id, note_id, tag_id, created_time, updated_time) VALUES (?, ?, ?, ?, ?)', ['nt1', 'n1', 't1', 1000, 2000]);
		await db.exec('INSERT INTO resources (id, title, mime, filename, created_time, updated_time, file_extension) VALUES (?, ?, ?, ?, ?, ?, ?)', ['r1', 'Resource 1', 'image/png', 'r1.png', 1000, 2000, 'png']);
		await db.close();

		db = await openDatabase(filePath);
		const output = {
			settings: await dumpRows(db, 'SELECT * FROM settings ORDER BY `key`'),
			folders: await dumpRows(db, 'SELECT * FROM folders ORDER BY id'),
			notes: await dumpRows(db, 'SELECT * FROM notes ORDER BY id'),
			tags: await dumpRows(db, 'SELECT * FROM tags ORDER BY id'),
			noteTags: await dumpRows(db, 'SELECT * FROM note_tags ORDER BY id'),
			resources: await dumpRows(db, 'SELECT * FROM resources ORDER BY id'),
			resourceLocalStates: await dumpRows(db, 'SELECT * FROM resource_local_states ORDER BY id'),
			itemChanges: await dumpRows(db, 'SELECT id, item_type, item_id, type, source, before_change_item FROM item_changes ORDER BY id'),
			tagsWithNoteCount: await dumpRows(db, 'SELECT * FROM tags_with_note_count ORDER BY id'),
		};
		await db.close();

		expect(output).toMatchSnapshot();
	}, 60000);

});
