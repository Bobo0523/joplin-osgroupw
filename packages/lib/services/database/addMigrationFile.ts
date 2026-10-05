import { dynamicQb } from './kysely';

export default (num: number) => {
	const timestamp = Date.now();
	return dynamicQb.insertInto('migrations').values({ number: num, created_time: timestamp, updated_time: timestamp });
};
