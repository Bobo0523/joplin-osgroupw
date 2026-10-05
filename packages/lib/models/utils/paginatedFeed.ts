import JoplinDatabase from '../../JoplinDatabase';
import applyPaginationOrder from './applyPaginationOrder';
import { Pagination, PaginationOrder } from './types';
import { Condition, dynamicQb, selectFields } from '../../services/database/kysely';

export interface ModelFeedPage {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous: callers receive entity types (Note/Folder/Resource) which lack index signatures
	items: any[];
	has_more: boolean;
	total?: number;
}

// Note: this method might return more fields than was requested as it will
// also return fields that are necessary for pagination.
export default async function(db: JoplinDatabase, tableName: string, pagination: Pagination, conditions: Condition[] = null, fields: string[] = null): Promise<ModelFeedPage> {
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

	let query = selectFields(dynamicQb.selectFrom(tableName), fields.length ? fields : '*');
	for (const condition of conditions ? conditions : []) query = query.where(condition);
	query = applyPaginationOrder(query, pagination.order, pagination.caseInsensitive)
		.limit(pagination.limit)
		.offset(offset);

	const rows = await db.selectAll(query);

	return {
		items: rows,
		has_more: rows.length >= pagination.limit,
	};
}
