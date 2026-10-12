import JoplinDatabase from '../../JoplinDatabase';
import { DatabaseDriverNode } from '../../database-driver-node';
import { createTempDir } from '../../testing/test-utils';
import { AnyQuery } from './kysely';

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

interface PragmaRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

class StopUpgradeError extends Error {}

// Lets a database be brought to an older version using the existing upgrade
// steps: the batch that would record version `stopAfterVersion + 1` is
// rejected before it runs, so the database stays at `stopAfterVersion`.
class StoppableJoplinDatabase extends JoplinDatabase {
	public stopAfterVersion: number | null = null;

	public override async transactionExecBatch(queries: AnyQuery[]) {
		if (this.stopAfterVersion !== null) {
			const stopVersion = this.stopAfterVersion + 1;
			const isStopBatch = queries.map(q => this.wrapQuery(q)).some(q => /^update [`"]?version[`"]? set [`"]?version[`"]? = \?$/i.test(q.sql) && q.params && q.params[0] === stopVersion);
			if (isStopBatch) throw new StopUpgradeError(`Stopped before version ${stopVersion}`);
		}
		return super.transactionExecBatch(queries);
	}
}

// ALTER TABLE ADD COLUMN and re-created objects can leave different whitespace
// in sqlite_master.sql, which has no effect on the schema, so it is collapsed.
const normaliseSql = (sql: string | null) => sql === null ? null : sql.replace(/\s+/g, ' ').trim();

const openDatabase = async (stopAfterVersion: number | null = null) => {
	const db = new StoppableJoplinDatabase(new DatabaseDriverNode());
	db.stopAfterVersion = stopAfterVersion;
	const filePath = `${await createTempDir()}/database.sqlite`;
	if (stopAfterVersion === null) {
		await db.open({ name: filePath });
	} else {
		await expect(db.open({ name: filePath })).rejects.toThrow(StopUpgradeError);
	}
	return db;
};

const schemaFingerprint = async (db: JoplinDatabase) => {
	const masterRows = await db.selectAll<MasterRow>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');

	const objects = masterRows.map(r => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: normaliseSql(r.sql) }));

	const columns: Record<string, PragmaRow[]> = {};
	for (const row of masterRows) {
		if (row.type !== 'table' && row.type !== 'view') continue;
		columns[row.name] = await db.selectAll<PragmaRow>(`PRAGMA table_info("${row.name}")`);
	}

	const tableFieldTables = (await db.selectAll<{ table_name: string }>('SELECT DISTINCT table_name FROM table_fields ORDER BY table_name')).map(r => r.table_name);

	const tableFields: Record<string, unknown> = {};
	const defaultRows: Record<string, unknown> = {};
	for (const tableName of tableFieldTables) {
		tableFields[tableName] = db.tableFields(tableName);
		defaultRows[tableName] = db.createDefaultRow(tableName);
	}

	return { objects, columns, tableFields, defaultRows };
};

const databaseVersion = async (db: JoplinDatabase) => {
	const rows = await db.selectAll<{ version: number }>('SELECT version FROM version LIMIT 1');
	return rows[0].version;
};

describe('schema', () => {

	test('should match the schema fingerprint of a fresh database', async () => {
		const db = await openDatabase();
		expect(await schemaFingerprint(db)).toMatchSnapshot();
		await db.close();
	});

	test.each([40, 45])('should give the same schema when upgrading from version %d', async (oldVersion) => {
		const freshDb = await openDatabase();
		const latestVersion = await databaseVersion(freshDb);

		const oldDb = await openDatabase(oldVersion);
		expect(await databaseVersion(oldDb)).toBe(oldVersion);

		oldDb.stopAfterVersion = null;
		await oldDb.initialize();
		expect(await databaseVersion(oldDb)).toBe(latestVersion);

		expect(await schemaFingerprint(oldDb)).toEqual(await schemaFingerprint(freshDb));

		await oldDb.close();
		await freshDb.close();
	});

});
