import JoplinDatabase from '../../JoplinDatabase';
import { orderBy, selectFrom } from '../../services/database/kysely';
import { legacyFragment } from '../../services/database/sqlFragments';
import { Pagination, PaginationOrder } from './types';
import { Expression, SqlBool } from 'kysely';

export interface ModelFeedPage {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous: callers receive entity types (Note/Folder/Resource) which lack index signatures
	items: any[];
	has_more: boolean;
	total?: number;
}

interface LegacyWhereQuery {
	sql: string;
	params?: (string | number | boolean)[];
}

export type WhereQuery = LegacyWhereQuery | Expression<SqlBool>;

const isLegacyWhereQuery = (whereQuery: WhereQuery): whereQuery is LegacyWhereQuery => 'sql' in whereQuery;

// Note: this method might return more fields than was requested as it will
// also return fields that are necessary for pagination.
export default async function(db: JoplinDatabase, tableName: string, pagination: Pagination, whereQuery: WhereQuery = null, fields: string[] = null): Promise<ModelFeedPage> {
	fields = fields ? fields.slice() : ['id'];

	if (!pagination.order.length) throw new Error('Pagination order must be provided');
	if (pagination.order.length > 1) throw new Error('Only one pagination order field can be provided');

	const paginationOrder = pagination.order[0].dir;

	if (!pagination.order.find((o: PaginationOrder) => o.by === 'id')) {
		pagination = {
			...pagination,
			order: pagination.order.concat([{
				by: 'id',
				dir: paginationOrder,
				caseInsensitive: false,
			}]),
		};
	}

	const offset = (pagination.page - 1) * pagination.limit;

	let query = selectFrom(tableName, fields.length ? fields : '*');
	if (whereQuery) {
		if (!isLegacyWhereQuery(whereQuery)) {
			query = query.where(whereQuery);
		} else if (whereQuery.sql) {
			query = query.where(legacyFragment<boolean>(whereQuery.sql, whereQuery.params ? whereQuery.params.slice() : []));
		}
	}
	query = orderBy(query, pagination.order, pagination.caseInsensitive).limit(pagination.limit).offset(offset);

	const rows = await db.selectAll(query);

	return {
		items: rows,
		has_more: rows.length >= pagination.limit,
	};
}
