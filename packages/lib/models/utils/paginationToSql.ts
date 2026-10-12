import { Pagination } from './types';
import { orderByTerm } from '../../services/database/sqlFragments';

const paginationToOrderBy = (pagination: Pagination) => {
	return pagination.order.map(o => orderByTerm(o.by, !!o.caseInsensitive || !!pagination.caseInsensitive, o.dir));
};

export default paginationToOrderBy;
