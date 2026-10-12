/* eslint-disable id-denylist */

import { Expression, QueryCreator, SqlBool } from 'kysely';
import { DynamicDatabaseSchema } from '../database/kyselyTypes';
import time from '../../time';
import { DynamicSelectQuery, dynamicExpression as eb, dynamicKysely as db, toSqlQuery } from '../database/kysely';
import { ConnectiveItem, connectiveChain, ftsMatch, ftsMatchInfo, ftsOffsets } from '../database/sqlFragments';

interface Term {
	name: string;
	value: string;
	negated: boolean;
}

enum Relation {
	OR = 'OR',
	AND = 'AND',
}

enum Operation {
	UNION = 'UNION',
	INTERSECT = 'INTERSECT',
}

enum Requirement {
	EXCLUSION = 'EXCLUSION',
	INCLUSION = 'INCLUSION',
}

interface Cte {
	name: string;
	query: DynamicSelectQuery;
}

interface QueryState {
	conditions: ConnectiveItem[];
	withClauses: Cte[];
	// Used to bind the parameters in the same order as the original string-built
	// queries - see queryBuilder() below.
	cteParamCount: number;
	noteIdParamCount: number;
}

type Condition = Expression<SqlBool>;

const _notebookFilter = (notebooks: string[], requirement: Requirement, state: QueryState, useFts: boolean) => {
	if (notebooks.length === 0) return;

	const relevantFolders = eb.or(notebooks.map(notebook => eb('folders.title', 'like', notebook)));

	const viewName: string = requirement === Requirement.EXCLUSION ? 'notebooks_not_in_scope' : 'notebooks_in_scope';
	const withInNotebook = db.selectFrom('folders')
		.select('folders.id')
		.where('id', 'in', db.selectFrom('folders').select('id').where(relevantFolders))
		.unionAll(db.selectFrom('folders').innerJoin(viewName, 'folders.parent_id', `${viewName}.id`).select('folders.id')) as DynamicSelectQuery;

	const tableName: string = useFts ? 'notes_normalized' : 'notes';
	const notesInScope = db.selectFrom(viewName).innerJoin(tableName, `${viewName}.id`, `${tableName}.parent_id`).select(`${tableName}.ROWID`);

	state.withClauses.push({ name: `${viewName}(id)`, query: withInNotebook });
	state.cteParamCount += notebooks.length;
	state.conditions.push({ connective: Relation.AND, expression: eb('ROWID', requirement === Requirement.EXCLUSION ? 'not in' : 'in', notesInScope) });
};

const notebookFilter = (terms: Term[], state: QueryState, useFts: boolean) => {
	const notebooksToInclude = terms.filter(x => x.name === 'notebook' && !x.negated).map(x => x.value);
	_notebookFilter(notebooksToInclude, Requirement.INCLUSION, state, useFts);

	const notebooksToExclude = terms.filter(x => x.name === 'notebook' && x.negated).map(x => x.value);
	_notebookFilter(notebooksToExclude, Requirement.EXCLUSION, state, useFts);
};



const getOperator = (requirement: Requirement, relation: Relation): Operation => {
	if (relation === 'AND' && requirement === 'INCLUSION') { return Operation.INTERSECT; } else { return Operation.UNION; }
};

const filterByTableName = (
	terms: Term[],
	state: QueryState,
	relation: Relation,
	noteIDs: (value: string)=> DynamicSelectQuery,
	requirement: Requirement,
	tableName: string,
	useFts: boolean,
) => {
	const operator: Operation = getOperator(requirement, relation);

	const values = terms.map(x => x.value);

	let withCondition: DynamicSelectQuery = null;

	if (relation === Relation.OR && requirement === Requirement.EXCLUSION) {
		// with_${requirement}_${tableName} is added to the names to make them unique
		const allNotesName = `all_notes_with_${requirement}_${tableName}`;
		state.withClauses.push({
			name: allNotesName,
			query: db.selectFrom(`note_${tableName}`).select(`note_${tableName}.note_id as id`).distinct() as DynamicSelectQuery,
		});

		const notesWithoutExcludedField = (value: string) => {
			return db.selectFrom(db.selectFrom(allNotesName).selectAll().except(noteIDs(value)).as('notes_without_excluded_field')).selectAll() as DynamicSelectQuery;
		};

		// We need notes without at least one excluded (tag/resource)
		withCondition = values.map(notesWithoutExcludedField).reduce((query, next) => query.union(next));
	} else {
		// Notes with any/all values depending upon relation and requirement
		withCondition = values.reduce(
			(query, value) => operator === Operation.INTERSECT ? query.intersect(noteIDs(value)) : query.union(noteIDs(value)),
			db.selectFrom(`note_${tableName}`).select(`note_${tableName}.note_id as id`).where(eb.lit(operator === Operation.INTERSECT ? 1 : 0)) as DynamicSelectQuery,
		);
	}

	// Get the ROWIDs that satisfy the condition so we can filter the result
	const cteName = `notes_with_${requirement}_${tableName}`;
	const targetTableName: string = useFts ? 'notes_normalized' : 'notes';
	const matchingNotes = db.selectFrom(cteName).innerJoin(targetTableName, `${cteName}.id`, `${targetTableName}.id`).select(`${targetTableName}.ROWID`);

	state.withClauses.push({ name: cteName, query: withCondition });
	state.cteParamCount += values.length;
	state.conditions.push({ connective: relation, expression: eb('ROWID', (relation === 'AND' && requirement === 'EXCLUSION') ? 'not in' : 'in', matchingNotes) });
};


const resourceFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const tableName = 'resources';

	const noteIDsWithResource = (value: string) => db.selectFrom('note_resources')
		.select('note_resources.note_id as id')
		.where('note_resources.is_associated', '=', eb.lit(1))
		.where('note_resources.resource_id', 'in', db.selectFrom('resources').select('resources.id').where('resources.mime', 'like', value)) as DynamicSelectQuery;

	const requiredResources = terms.filter(x => x.name === 'resource' && !x.negated);
	const excludedResources = terms.filter(x => x.name === 'resource' && x.negated);

	if (requiredResources.length > 0) {
		filterByTableName(requiredResources, state, relation, noteIDsWithResource, Requirement.INCLUSION, tableName, useFts);
	}

	if (excludedResources.length > 0) {
		filterByTableName(excludedResources, state, relation, noteIDsWithResource, Requirement.EXCLUSION, tableName, useFts);
	}
};

const tagFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const tableName = 'tags';

	const noteIDsWithTag = (value: string) => db.selectFrom('note_tags')
		.select('note_tags.note_id as id')
		.where('note_tags.tag_id', 'in', db.selectFrom('tags').select('tags.id').where('tags.title', 'like', value)) as DynamicSelectQuery;

	const requiredTags = terms.filter(x => x.name === 'tag' && !x.negated);
	const excludedTags = terms.filter(x => x.name === 'tag' && x.negated);

	if (requiredTags.length > 0) {
		filterByTableName(requiredTags, state, relation, noteIDsWithTag, Requirement.INCLUSION, tableName, useFts);
	}

	if (excludedTags.length > 0) {
		filterByTableName(excludedTags, state, relation, noteIDsWithTag, Requirement.EXCLUSION, tableName, useFts);
	}
};

const genericFilter = (terms: Term[], state: QueryState, relation: Relation, fieldName: string, useFts: boolean) => {
	if (fieldName === 'iscompleted' || fieldName === 'type') {
		// Faster query when values can only take two distinct values
		biConditionalFilter(terms, state, relation, fieldName, useFts);
		return;
	}

	const tableName = useFts ? 'notes_normalized' : 'notes';

	const getCondition = (term: Term): Condition => {
		if (fieldName === 'sourceurl') {
			return eb(`${tableName}.source_url`, term.negated ? 'not like' : 'like', term.value);
		} else if (fieldName === 'date' && term.name === 'due') {
			return eb('todo_due', term.negated ? '<' : '>=', term.value);
		} else if (fieldName === 'id') {
			return eb('id', term.negated ? 'not like' : 'like', term.value);
		} else {
			return eb(`${tableName}.${fieldName === 'date' ? `user_${term.name}_time` : `${term.name}`}`, term.negated ? '<' : '>=', term.value);
		}
	};

	// eslint-disable-next-line github/array-foreach -- Old code before rule was applied
	terms.forEach(term => {
		const matchingRows = eb('ROWID', 'in', db.selectFrom(tableName).select('ROWID').where(getCondition(term)));
		state.conditions.push({
			connective: relation,
			expression: term.name === 'due' ? eb.and([eb('is_todo', 'is', eb.lit(1)), matchingRows]) : matchingRows,
		});
		if (fieldName === 'id') state.noteIdParamCount++;
	});
};

const biConditionalFilter = (terms: Term[], state: QueryState, relation: Relation, filterName: string, useFts: boolean) => {
	const getCondition = (filterName: string, value: string, relation: Relation): Condition => {
		const tableName = useFts ? (relation === 'AND' ? 'notes_fts' : 'notes_normalized') : 'notes';
		if (filterName === 'type') {
			return eb(`${tableName}.is_todo`, 'is', eb.lit(value === 'todo' ? 1 : 0));
		} else if (filterName === 'iscompleted') {
			return eb.and([
				eb(`${tableName}.is_todo`, 'is', eb.lit(1)),
				eb(`${tableName}.todo_completed`, value === '1' ? 'is not' : 'is', eb.lit(0)),
			]);
		} else {
			throw new Error('Invalid filter name.');
		}
	};

	const values = terms.map(x => x.value);

	// AND and OR are handled differently because FTS restricts how OR can be used.
	// eslint-disable-next-line github/array-foreach -- Old code before rule was applied
	values.forEach(value => {
		if (relation === 'AND') {
			state.conditions.push({ connective: Relation.AND, expression: getCondition(filterName, value, relation) });
		}
		if (relation === 'OR') {
			if (useFts) {
				state.conditions.push({
					connective: Relation.OR,
					expression: eb('ROWID', 'in', db.selectFrom('notes_normalized').select('ROWID').where(getCondition(filterName, value, relation))),
				});
			} else {
				state.conditions.push({ connective: Relation.OR, expression: getCondition(filterName, value, relation) });
			}
		}
	});
};

const noteIdFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const noteIdTerms = terms.filter(x => x.name === 'id');
	genericFilter(noteIdTerms, state, relation, 'id', useFts);
};


const typeFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const typeTerms = terms.filter(x => x.name === 'type');
	genericFilter(typeTerms, state, relation, 'type', useFts);
};

const completedFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const completedTerms = terms.filter(x => x.name === 'iscompleted');
	genericFilter(completedTerms, state, relation, 'iscompleted', useFts);
};


const locationFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const locationTerms = terms.filter(x => x.name === 'latitude' || x.name === 'longitude' || x.name === 'altitude');
	genericFilter(locationTerms, state, relation, 'location', useFts);
};

const dateFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const getUnixMs = (date: string): string => {
		const yyyymmdd = /^[0-9]{8}$/;
		const yyyymm = /^[0-9]{6}$/;
		const yyyy = /^[0-9]{4}$/;
		const smartValue = /^(day|week|month|year)(\+|-)([0-9]+)$/i;

		if (yyyymmdd.test(date)) {
			return time.formatLocalToMs(date, 'YYYYMMDD').toString();
		} else if (yyyymm.test(date)) {
			return time.formatLocalToMs(date, 'YYYYMM').toString();
		} else if (yyyy.test(date)) {
			return time.formatLocalToMs(date, 'YYYY').toString();
		} else if (smartValue.test(date)) {
			const match = smartValue.exec(date);
			const timeUnit = match[1]; // eg. day, week, month, year
			const timeDirection = match[2]; // + or -
			const num = Number(match[3]); // eg. 1, 12, 15

			if (timeDirection === '+') { return time.goForwardInTime(Date.now(), num, timeUnit); } else { return time.goBackInTime(Date.now(), num, timeUnit); }
		} else {
			throw new Error('Invalid date format!');
		}
	};

	const dateTerms = terms.filter(x => x.name === 'created' || x.name === 'updated' || x.name === 'due');
	const unixDateTerms = dateTerms.map(term => { return { ...term, value: getUnixMs(term.value) }; });
	genericFilter(unixDateTerms, state, relation, 'date', useFts);
};

const sourceUrlFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const urlTerms = terms.filter(x => x.name === 'sourceurl');
	genericFilter(urlTerms, state, relation, 'sourceurl', useFts);
};

const trimQuotes = (str: string) => str.startsWith('"') && str.endsWith('"') ? str.substr(1, str.length - 2) : str;

const textFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const createLikeMatch = (term: Term, negate: boolean) => {
		const param = `%${trimQuotes(term.value).replace(/\*/, '%')}%`;
		const likes: Condition[] = [];
		if (term.name === 'text' || term.name === 'body') likes.push(eb('notes.body', 'like', param));
		if (term.name === 'text' || term.name === 'title') likes.push(eb('notes.title', 'like', param));
		const match = eb.or(likes);
		state.conditions.push({ connective: relation, expression: negate ? eb.not(match) : match });
	};

	const addExcludeTextConditions = (excludedTerms: Term[], relation: Relation) => {
		if (useFts) {
			const columnName = excludedTerms[0].name === 'text' ? 'notes_fts' : `notes_fts.${excludedTerms[0].name}`;
			if (relation === 'AND') {
				state.conditions.push({
					connective: Relation.AND,
					expression: eb('ROWID', 'not in', db.selectFrom('notes_fts').select('ROWID').where(ftsMatch(columnName, excludedTerms.map(x => x.value).join(' OR ')))),
				});
			}
			if (relation === 'OR') {
				// eslint-disable-next-line github/array-foreach -- Old code before rule was applied
				excludedTerms.forEach(term => {
					const notMatching = db.selectFrom('notes_fts').select('ROWID').except(db.selectFrom('notes_fts').select('ROWID').where(ftsMatch(columnName, term.value)));
					state.conditions.push({
						connective: Relation.OR,
						expression: eb('ROWID', 'in', db.selectFrom(notMatching.as('not_matching')).selectAll()),
					});
				});
			}
		} else {
			// eslint-disable-next-line github/array-foreach -- Old code before rule was applied
			excludedTerms.forEach(term => {
				createLikeMatch(term, true);
			});
		}
	};

	const allTerms = terms.filter(x => x.name === 'title' || x.name === 'body' || x.name === 'text');

	const includedTerms = allTerms.filter(x => !x.negated);
	if (includedTerms.length > 0) {
		if (useFts) {
			const termsToMatch = includedTerms.map(term => {
				if (term.name === 'text') return term.value;
				else return `${term.name}:${term.value}`;
			});
			const matchQuery = (relation === 'OR') ? termsToMatch.join(' OR ') : termsToMatch.join(' ');
			state.conditions.push({ connective: relation, expression: ftsMatch('notes_fts', matchQuery) });
		} else {
			// eslint-disable-next-line github/array-foreach -- Old code before rule was applied
			includedTerms.forEach(term => {
				createLikeMatch(term, false);
			});
		}
	}

	const excludedTextTerms = allTerms.filter(x => x.name === 'text' && x.negated);
	const excludedTitleTerms = allTerms.filter(x => x.name === 'title' && x.negated);
	const excludedBodyTerms = allTerms.filter(x => x.name === 'body' && x.negated);

	if ((excludedTextTerms.length > 0)) {
		addExcludeTextConditions(excludedTextTerms, relation);
	}

	if (excludedTitleTerms.length > 0) {
		addExcludeTextConditions(excludedTitleTerms, relation);
	}

	if (excludedBodyTerms.length > 0) {
		addExcludeTextConditions(excludedBodyTerms, relation);
	}
};

const getDefaultRelation = (terms: Term[]): Relation => {
	const anyTerm = terms.find(term => term.name === 'any');
	if (anyTerm) { return (anyTerm.value === '1') ? Relation.OR : Relation.AND; }
	return Relation.AND;
};

const getConnective = (terms: Term[], relation: Relation): string => {
	const notebookTerm = terms.find(x => x.name === 'notebook');
	return (!notebookTerm && (relation === 'OR')) ? 'ROWID=-1' : '1'; // ROWID=-1 acts as 0 (something always false)
};

export default function queryBuilder(terms: Term[], useFts: boolean) {
	const state: QueryState = { conditions: [], withClauses: [], cteParamCount: 0, noteIdParamCount: 0 };

	const relation: Relation = getDefaultRelation(terms);

	const tableName = useFts ? 'notes_fts' : 'notes';

	noteIdFilter(terms, state, relation, useFts);

	notebookFilter(terms, state, useFts);

	tagFilter(terms, state, relation, useFts);

	resourceFilter(terms, state, relation, useFts);

	textFilter(terms, state, relation, useFts);


	typeFilter(terms, state, relation, useFts);

	completedFilter(terms, state, relation, useFts);

	dateFilter(terms, state, relation, useFts);

	locationFilter(terms, state, relation, useFts);

	sourceUrlFilter(terms, state, relation, useFts);

	const connective = getConnective(terms, relation) === '1' ? eb.lit(1) : eb('ROWID', '=', eb.lit(-1));
	const conditions = state.conditions;

	let where = connectiveChain(connective, conditions);
	if (state.withClauses.length > 0 && terms.find(x => x.name === 'notebook') && terms.find(x => x.name === 'any')) {
		// The notebook filter should be independent of the any filter.
		// So we're first finding the OR of other filters and then combining them with the notebook filter using AND
		// in-required-notebook AND (condition #1 OR condition #2  OR ... )
		const otherConditions = db.selectFrom('notes_fts').select('ROWID').where(connectiveChain(eb(eb.lit<number>(1), '=', eb.lit<number>(0)), conditions.slice(1)));
		where = connectiveChain(connective, [conditions[0], { connective: Relation.AND, expression: eb('ROWID', 'in', otherConditions) }]);
	}

	const query = state.withClauses.reduce<QueryCreator<DynamicDatabaseSchema>>(
		(builder, cte, index) => index === 0 ? builder.withRecursive(cte.name, () => cte.query) : builder.with(cte.name, () => cte.query),
		db,
	)
		.selectFrom(tableName)
		.select([
			`${tableName}.id`,
			`${tableName}.title`,
			...(useFts ? [ftsOffsets('notes_fts').as('offsets'), ftsMatchInfo('notes_fts').as('matchinfo')] : []),
			`${tableName}.user_created_time`,
			`${tableName}.user_updated_time`,
			`${tableName}.is_todo`,
			`${tableName}.todo_completed`,
			`${tableName}.parent_id`,
		])
		.where(where);

	const { sql, params } = toSqlQuery(query);

	// The original version of this function, which built the query as a
	// string, bound the parameters of the "id:" filters before those of the
	// notebook, tag and resource filters, even though the latter come first in
	// the query (in the WITH clause). This is preserved here so that search
	// results stay exactly the same. See MIGRATION_PLAN.md, "Follow-ups".
	const cteParams = params.slice(0, state.cteParamCount);
	const noteIdParams = params.slice(state.cteParamCount, state.cteParamCount + state.noteIdParamCount);
	const otherParams = params.slice(state.cteParamCount + state.noteIdParamCount);

	return { query: sql, params: [...noteIdParams, ...cteParams, ...otherParams] };
}
