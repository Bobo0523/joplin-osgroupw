import Logger from '@joplin/utils/Logger';
import time from './time';
import shim from './shim';
import { SqlParams, SqlQuery, StringOrSqlQuery } from './services/database/types';
import { ColumnDefinition, compileQuery, dynamicQb, isQuery, keepUndefinedValues, Query, QueryOrSql, sql, toSqlQuery } from './services/database/kysely';

import { Mutex } from 'async-mutex';

// Row values come back as SQLite primitives (string|number|null|Buffer for BLOBs)
// but per-table column shapes vary, and callers across the codebase index without
// runtime narrowing; widening here would require dozens of casts at call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- See above
export type Row = Record<string, any>;

export default class Database {

	public static TYPE_UNKNOWN = 0;
	public static TYPE_INT = 1;
	public static TYPE_TEXT = 2;
	public static TYPE_NUMERIC = 3;

	protected debugMode_ = false;
	private sqlQueryLogEnabled_ = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Driver shape varies per platform (better-sqlite3, web sqlite, RN sqlite) and exposes additional non-interface methods like sqliteErrorToJsError, close, loadExtension
	private driver_: any;
	private logger_ = new Logger();
	private logExcludedQueryTypes_: string[] = [];
	private batchTransactionMutex_ = new Mutex();
	private profilingEnabled_ = false;
	private queryId_ = 1;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- See driver_ above
	public constructor(driver: any) {
		this.driver_ = driver;
	}

	public setLogExcludedQueryTypes(v: string[]) {
		this.logExcludedQueryTypes_ = v;
	}

	// Converts the SQLite error to a regular JS error
	// so that it prints a stacktrace when passed to
	// console.error()
	public sqliteErrorToJsError(error: Error & { code?: string }, sql: string = null, params: SqlParams = null) {
		return this.driver().sqliteErrorToJsError(error, sql, params);
	}

	public setLogger(l: Logger) {
		this.logger_ = l;
	}

	public logger() {
		return this.logger_;
	}

	public driver() {
		return this.driver_;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Open options vary per driver: better-sqlite3 expects { name }, web/RN drivers accept additional fields
	public async open(options: any) {
		try {
			await this.driver().open(options);
		} catch (error) {
			throw new Error(`Cannot open database: ${error.message ?? error}: ${JSON.stringify(options)}`);
		}

		this.logger().info('Database was open successfully');
	}

	public async close() {
		try {
			await this.driver().close?.();
		} catch (error) {
			this.logger().warn('Failed to close database', error);
		}
	}

	public async tryCall(callName: string, inputSql: QueryOrSql, inputParams: SqlParams) {
		const { sql, params } = toSqlQuery(inputSql, inputParams);

		let waitTime = 50;
		let totalWaitTime = 0;
		const callStartTime = Date.now();
		let profilingTimeoutId = null;
		while (true) {
			try {
				this.logQuery(sql, params);

				const queryId = this.queryId_++;
				if (this.profilingEnabled_) {
					// eslint-disable-next-line no-console
					console.info(`SQL START ${queryId}`, sql, params);

					profilingTimeoutId = shim.setInterval(() => {
						console.warn(`SQL ${queryId} has been running for ${Date.now() - callStartTime}: ${sql}`);
					}, 3000);
				}

				const result = await this.driver()[callName](sql, params);

				if (this.profilingEnabled_) {
					shim.clearInterval(profilingTimeoutId);
					profilingTimeoutId = null;
					const elapsed = Date.now() - callStartTime;
					// eslint-disable-next-line no-console
					if (elapsed > 10) console.info(`SQL END ${queryId}`, elapsed, sql, params);
				}

				return result; // No exception was thrown
			} catch (error) {
				if (error && (error.code === 'SQLITE_IOERR' || error.code === 'SQLITE_BUSY')) {
					if (totalWaitTime >= 20000) throw this.sqliteErrorToJsError(error, sql, params);
					// NOTE: don't put logger statements here because it might log to the database, which
					// could result in an error being thrown again.
					// this.logger().warn(sprintf('Error %s: will retry in %s milliseconds', error.code, waitTime));
					// this.logger().warn('Error was: ' + error.toString());
					await time.msleep(waitTime);
					totalWaitTime += waitTime;
					waitTime *= 1.5;
				} else {
					throw this.sqliteErrorToJsError(error, sql, params);
				}
			} finally {
				if (profilingTimeoutId) shim.clearInterval(profilingTimeoutId);
			}
		}
	}

	public async selectOne<T = Row>(sql: string | Query<T>, params: SqlParams = null): Promise<T> {
		return this.tryCall('selectOne', sql, params);
	}

	public async loadExtension(path: string) {
		try {
			return await this.driver().loadExtension(path);
		} catch (error) {
			error.message = `Could not load extension ${path}: ${error.message}`;
			throw error;
		}
	}

	public async selectAll<T = Row>(sql: string | Query<T>, params: SqlParams = null): Promise<T[]> {
		return this.tryCall('selectAll', sql, params);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Field values are heterogeneous per query (string ids, numbers, booleans); callers across models narrow at use-site
	public async selectAllFields(inputSql: string | Query, params: SqlParams, field: string): Promise<any[]> {
		const query = toSqlQuery(inputSql, params);
		const rows = await this.tryCall('selectAll', query, null);
		const output = [];
		for (let i = 0; i < rows.length; i++) {
			const v = rows[i][field];
			if (!v) throw new Error(`No such field: ${field}. Query was: ${query.sql}`);
			output.push(rows[i][field]);
		}
		return output;
	}

	public async exec(sql: StringOrSqlQuery | Query, params: SqlParams = null) {
		return this.tryCall('exec', sql, params);
	}

	public async transactionExecBatch(queries: (StringOrSqlQuery | Query)[]) {
		if (queries.length <= 0) return;

		if (queries.length === 1) {
			const q = this.wrapQuery(queries[0]);
			await this.exec(q.sql, q.params);
			return;
		}

		// There can be only one transaction running at a time so use a	mutex
		const release = await this.batchTransactionMutex_.acquire();

		try {
			await this.exec(sql`BEGIN TRANSACTION`);

			for (let i = 0; i < queries.length; i++) {
				const query = this.wrapQuery(queries[i]);
				await this.exec(query.sql, query.params);
			}

			await this.exec(sql`COMMIT`);
		} catch (error) {
			await this.exec(sql`ROLLBACK`);
			throw error;
		} finally {
			release();
		}
	}

	public static enumId(type: string, s: string) {
		if (type === 'settings') {
			if (s === 'int') return 1;
			if (s === 'string') return 2;
		}
		if (type === 'fieldType') {
			if (s) s = s.toUpperCase();
			if (s === 'INTEGER') s = 'INT';
			if (!(`TYPE_${s}` in this)) throw new Error(`Unknown fieldType: ${s}`);
			return (this as unknown as Record<string, number>)[`TYPE_${s}`];
		}
		if (type === 'syncTarget') {
			if (s === 'memory') return 1;
			if (s === 'filesystem') return 2;
			if (s === 'onedrive') return 3;
		}
		throw new Error(`Unknown enum type or value: ${type}, ${s}`);
	}

	public static enumName(type: string, id: number) {
		if (type === 'fieldType') {
			if (id === Database.TYPE_UNKNOWN) return 'unknown';
			if (id === Database.TYPE_INT) return 'int';
			if (id === Database.TYPE_TEXT) return 'text';
			if (id === Database.TYPE_NUMERIC) return 'numeric';
			throw new Error(`Invalid type id: ${id}`);
		}

		// Or maybe an error should be thrown
		return undefined;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Input/output flow into TableField.default which is string|number|boolean; narrowing to unknown breaks downstream consumers
	public static formatValue(type: number, value: any) {
		if (value === null || value === undefined) return null;
		if (type === this.TYPE_INT) return Number(value);
		if (type === this.TYPE_TEXT) return value;
		if (type === this.TYPE_NUMERIC) return Number(value);
		throw new Error(`Unknown type: ${type}`);
	}

	public logQuery(sql: string, params: SqlParams = null) {
		if (!this.sqlQueryLogEnabled_) return;

		if (this.logExcludedQueryTypes_.length) {
			const temp = sql.toLowerCase();
			for (let i = 0; i < this.logExcludedQueryTypes_.length; i++) {
				if (temp.indexOf(this.logExcludedQueryTypes_[i].toLowerCase()) === 0) return;
			}
		}

		this.logger().debug(sql);
		if (params !== null && params.length) this.logger().debug(JSON.stringify(params));
	}

	// Keys ending with "_" are not database fields.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- data is an arbitrary entity slice (e.g. NoteEntity, FolderEntity); narrowing forces index-signature errors at call sites
	private static queryValues(data: Record<string, any>) {
		const output: Record<string, unknown> = {};
		for (const key in data) {
			if (!data.hasOwnProperty(key)) continue;
			if (key[key.length - 1] === '_') continue;
			output[key] = data[key];
		}
		return keepUndefinedValues(output);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- See queryValues above
	public static insertQuery(tableName: string, data: Record<string, any>) {
		if (!data || !Object.keys(data).length) throw new Error('Data is empty');

		return compileQuery(dynamicQb.insertInto(tableName).values(this.queryValues(data)));
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- See queryValues above
	public static updateQuery(tableName: string, data: Record<string, any>, where: string | Record<string, any>) {
		if (!data || !Object.keys(data).length) throw new Error('Data is empty');

		let query = dynamicQb.updateTable(tableName).set(this.queryValues(data));

		if (typeof where === 'string') {
			query = query.where(sql<boolean>`${sql.raw(where)}`);
		} else {
			for (const n in where) {
				if (!where.hasOwnProperty(n)) continue;
				query = query.where(n, '=', where[n]);
			}
		}

		return compileQuery(query);
	}

	// Recreates the table with the given column definitions, keeping its content.
	public alterColumnQueries(tableName: string, fields: Record<string, ColumnDefinition>) {
		const backupTableName = `${tableName}_backup`;
		const fieldNames = Object.keys(fields);

		const createTable = (name: string, temporary: boolean) => {
			let query = dynamicQb.schema.createTable(name);
			if (temporary) query = query.temporary();
			for (const n of fieldNames) {
				const [type, build] = fields[n];
				query = query.addColumn(n, type, build ? build : c => c);
			}
			return query;
		};

		return [
			createTable(backupTableName, true),
			dynamicQb.insertInto(backupTableName).expression(dynamicQb.selectFrom(tableName).select(fieldNames)),
			dynamicQb.schema.dropTable(tableName),
			createTable(tableName, false),
			dynamicQb.insertInto(tableName).expression(dynamicQb.selectFrom(backupTableName).select(fieldNames)),
			dynamicQb.schema.dropTable(backupTableName),
		].map(q => compileQuery(q));
	}

	public wrapQueries(queries: (string | SqlQuery | Query | [string, SqlParams?])[]) {
		const output = [];
		for (let i = 0; i < queries.length; i++) {
			output.push(this.wrapQuery(queries[i]));
		}
		return output;
	}

	public wrapQuery(sql: string | SqlQuery | Query | [string, SqlParams?], params: SqlParams = null): SqlQuery {
		if (!sql) throw new Error(`Cannot wrap empty string: ${sql}`);

		if (Array.isArray(sql)) {
			return {
				sql: sql[0],
				params: sql.length >= 2 ? sql[1] : null,
			};
		} else if (typeof sql === 'string') {
			return { sql: sql, params: params };
		} else if (isQuery(sql)) {
			return compileQuery(sql);
		} else {
			return sql; // Already wrapped
		}
	}
}
