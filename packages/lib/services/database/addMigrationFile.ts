import { insertRow, kysely } from './kysely';

export default (num: number) => {
	const timestamp = Date.now();
	return kysely.insertInto('migrations').values(insertRow('migrations', { number: num, created_time: timestamp, updated_time: timestamp }));
};
