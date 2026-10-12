import { Compilable, CompiledQuery, DummyDriver, Expression, expressionBuilder, Insertable, Kysely, SqlBool, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { KyselyDatabase, KyselyTableName } from './kyselyTypes';
import { SqlQuery, StringOrSqlQuery } from './types';

// Compile-only instance: queries are executed through Joplin's Database class, which keeps
// the platform drivers, busy-retry, logging and the transaction mutex.
export const kysely = new Kysely<KyselyDatabase>({
	dialect: {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: db => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	},
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Matches Kysely's own default for the row type
export type KyselyQuery<O = any> = Compilable<O>;

// For queries whose table and column names are only known at runtime (e.g. insertQuery
// called with arbitrary table names from other packages).
export type DynamicTables = Record<string, Record<string, unknown>>;
export const dynamicKysely = kysely as unknown as Kysely<DynamicTables>;

// A legacy SQL condition string (with `?` placeholders), or a Kysely expression
export type SqlCondition = string | Expression<SqlBool>;

export const notesExpression = expressionBuilder<KyselyDatabase, 'notes'>();

export type AnyQuery = StringOrSqlQuery | KyselyQuery;

export const isKyselyQuery = (query: unknown): query is KyselyQuery => {
	return !!query && typeof (query as KyselyQuery).compile === 'function';
};

export const toSqlQuery = (query: KyselyQuery | CompiledQuery): SqlQuery => {
	const compiled = isKyselyQuery(query) ? query.compile() : query;
	return {
		sql: compiled.sql,
		params: compiled.parameters.map(p => typeof p === 'boolean' ? Number(p) : p),
	};
};

// lib is compiled without strictNullChecks, so Kysely treats every column as required on
// insert. All columns have defaults in the schema, so partial rows are valid.
export const insertRow = <T extends KyselyTableName>(_table: T, row: Partial<Insertable<KyselyDatabase[T]>>) => {
	return row as Insertable<KyselyDatabase[T]>;
};
