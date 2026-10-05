import { SelectQueryBuilder } from 'kysely';
import { sql } from '../../services/database/kysely';

interface Order {
	by: string;
	dir: string;
	caseInsensitive?: boolean;
}

export default function applyPaginationOrder<DB, TB extends keyof DB, O>(query: SelectQueryBuilder<DB, TB, O>, order: Order[], caseInsensitive = false) {
	for (const o of order) {
		const dir = o.dir.toLowerCase();
		if (dir !== 'asc' && dir !== 'desc') throw new Error(`Invalid order direction: ${o.dir}`);
		const field = sql.id(o.by);
		query = query.orderBy(o.caseInsensitive || caseInsensitive ? sql`${field} COLLATE NOCASE` : field, dir);
	}
	return query;
}
