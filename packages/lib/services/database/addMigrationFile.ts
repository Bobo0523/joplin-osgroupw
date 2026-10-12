import { insertInto, toSqlQuery } from './kysely';

export default (num: number) => {
	const timestamp = Date.now();
	return toSqlQuery(insertInto('migrations', { number: num, created_time: timestamp, updated_time: timestamp }));
};
