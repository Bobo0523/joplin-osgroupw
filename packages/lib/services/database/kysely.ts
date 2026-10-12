import { Compilable, CompiledQuery, DummyDriver, expressionBuilder, Kysely, RawBuilder, SelectQueryBuilder, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { DatabaseSchema, DynamicDatabaseSchema } from './kyselyTypes';
import { SqlParams, SqlQuery } from './types';
import { rawOrderItem } from './sqlFragments';

// Kysely is only used to build the SQL. The queries are then run by
// Database, so that the platform drivers, the busy-retry logic, query
// logging and the transaction mutex all keep working as before. The
// DummyDriver makes sure Kysely itself can never run a query.
export const kysely = new Kysely<DatabaseSchema>({
	dialect: {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: db => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	},
});

export const dynamicKysely = kysely as unknown as Kysely<DynamicDatabaseSchema>;

// Builds conditions that are not attached to a query, for example for the
// `conditions` option of BaseModel.search() and Note.previews().
export const dynamicExpression = expressionBuilder<DynamicDatabaseSchema, string>();

// RawBuilder is for complete statements written with the `sql` tag in
// sqlFragments.ts, such as CREATE TRIGGER.
export type KyselyQuery = Compilable | CompiledQuery | RawBuilder<unknown>;

export type InsertValues<TableName extends keyof DatabaseSchema> = Partial<Record<keyof DatabaseSchema[TableName], unknown>>;

// lib is compiled without strictNullChecks, which makes Kysely's insert types
// treat every column as required, so inserts go through this helper. It
// still checks the column names, but not the value types.
export const insertInto = <TableName extends keyof DatabaseSchema>(tableName: TableName, values: InsertValues<TableName>) => {
	return dynamicKysely.insertInto(tableName).values(values);
};

export const isKyselyQuery = (query: unknown): query is KyselyQuery => {
	if (!query || typeof query !== 'object') return false;
	if (typeof (query as Compilable).compile === 'function') return true;
	return 'query' in query && 'parameters' in query && 'sql' in query;
};

export const toSqlQuery = (query: KyselyQuery): Required<SqlQuery> => {
	// Query builders ignore the argument, while RawBuilder needs it.
	const compiled = 'compile' in query && typeof query.compile === 'function' ? (query as RawBuilder<unknown>).compile(kysely) : query as CompiledQuery;
	return { sql: compiled.sql, params: compiled.parameters.slice() as SqlParams };
};

export type DynamicSelectQuery = SelectQueryBuilder<DynamicDatabaseSchema, string, Record<string, unknown>>;

export interface OrderItem {
	by: string;
	dir: string;
	caseInsensitive?: boolean;
}

// Same rules as Database.escapeFields(): '*' selects every column, and
// "table.column" names are allowed.
export const selectFields = (query: DynamicSelectQuery, fields: string | readonly string[]) => {
	if (fields === '*') return query.selectAll();
	for (const field of typeof fields === 'string' ? [fields] : fields) {
		query = field === '*' ? query.selectAll() : query.select(field);
	}
	return query;
};

export const selectFrom = (tableName: string, fields: string | readonly string[] = '*') => {
	return selectFields(dynamicKysely.selectFrom(tableName) as DynamicSelectQuery, fields);
};

export const orderBy = (query: DynamicSelectQuery, order: readonly OrderItem[], caseInsensitive = false) => {
	for (const o of order) {
		const collateNocase = !!o.caseInsensitive || !!caseInsensitive;
		const direction = typeof o.dir === 'string' ? o.dir.toLowerCase() : null;
		if ((direction === 'asc' || direction === 'desc') && !o.by.includes('.')) {
			query = query.orderBy(o.by, item => {
				const collated = collateNocase ? item.collate('nocase') : item;
				return direction === 'asc' ? collated.asc() : collated.desc();
			});
		} else {
			query = query.orderBy(rawOrderItem(o.by, collateNocase, o.dir));
		}
	}
	return query;
};
