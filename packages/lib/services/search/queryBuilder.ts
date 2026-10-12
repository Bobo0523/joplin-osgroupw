/* eslint-disable id-denylist */

import time from '../../time';
import { toSqlQuery } from '../database/kysely';
import { compileSearchFragment, joinSearchFragments, searchAllNotesWithCte, searchAndCondition, searchFtsExcludeAnd, searchFtsExcludeOr, searchFtsMatch, searchGenericCondition, searchGenericFilter, searchIsCompletedCondition, searchIsTodoCondition, searchLikeMatch, searchNotebookCondition, searchNotebookCte, searchNotebookFilterBody, SearchFragment, searchNotesWithCondition, searchNotesWithCte, searchNotesWithOperatorCte, searchNotesWithoutExcluded, searchOrCondition, searchOrNormalizedCondition, searchResourceNoteIds, searchSelectHead, searchTagNoteIds, searchWithRecursive } from '../database/sqlFragments';

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

interface QueryState {
	conditions: SearchFragment[];
	withs: SearchFragment[];
	withParamCount: number;
	idParamCount: number;
}

const _notebookFilter = (notebooks: string[], requirement: Requirement, state: QueryState, useFts: boolean) => {
	if (notebooks.length === 0) return;

	const viewName = requirement === Requirement.EXCLUSION ? 'notebooks_not_in_scope' : 'notebooks_in_scope';
	const tableName = useFts ? 'notes_normalized' : 'notes';

	state.withs.push(searchNotebookCte(viewName, notebooks));
	state.withParamCount += notebooks.length;
	state.conditions.push(searchNotebookCondition(viewName, tableName, requirement === Requirement.EXCLUSION));
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
	noteIDs: (value: string)=> SearchFragment,
	requirement: Requirement,
	tableName: string,
	useFts: boolean,
) => {
	const operator: Operation = getOperator(requirement, relation);

	const values = terms.map(x => x.value);

	let withCondition = null;

	if (relation === Relation.OR && requirement === Requirement.EXCLUSION) {
		// with_${requirement}_${tableName} is added to the names to make them unique
		state.withs.push(searchAllNotesWithCte(requirement, tableName));

		const requiredNotesQuery = joinSearchFragments(values.map(v => searchNotesWithoutExcluded(requirement, tableName, noteIDs(v))), ' UNION ');

		// We need notes without at least one excluded (tag/resource)
		withCondition = searchNotesWithCte(requirement, tableName, requiredNotesQuery);
	} else {
		const requiredNotesQuery = joinSearchFragments(values.map(v => noteIDs(v)), ` ${operator} `);

		// Notes with any/all values depending upon relation and requirement
		withCondition = searchNotesWithOperatorCte(requirement, tableName, operator, requiredNotesQuery);
	}

	// Get the ROWIDs that satisfy the condition so we can filter the result
	const targetTableName = useFts ? 'notes_normalized' : 'notes';
	const whereCondition = searchNotesWithCondition(relation, relation === 'AND' && requirement === 'EXCLUSION', requirement, tableName, targetTableName);

	state.withs.push(withCondition);
	state.withParamCount += values.length;
	state.conditions.push(whereCondition);
};

const resourceFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const tableName = 'resources';

	const requiredResources = terms.filter(x => x.name === 'resource' && !x.negated);
	const excludedResources = terms.filter(x => x.name === 'resource' && x.negated);

	if (requiredResources.length > 0) {
		filterByTableName(requiredResources, state, relation, searchResourceNoteIds, Requirement.INCLUSION, tableName, useFts);
	}

	if (excludedResources.length > 0) {
		filterByTableName(excludedResources, state, relation, searchResourceNoteIds, Requirement.EXCLUSION, tableName, useFts);
	}
};

const tagFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const tableName = 'tags';

	const requiredTags = terms.filter(x => x.name === 'tag' && !x.negated);
	const excludedTags = terms.filter(x => x.name === 'tag' && x.negated);

	if (requiredTags.length > 0) {
		filterByTableName(requiredTags, state, relation, searchTagNoteIds, Requirement.INCLUSION, tableName, useFts);
	}

	if (excludedTags.length > 0) {
		filterByTableName(excludedTags, state, relation, searchTagNoteIds, Requirement.EXCLUSION, tableName, useFts);
	}
};

const genericFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, fieldName: string, useFts: boolean) => {
	if (fieldName === 'iscompleted' || fieldName === 'type') {
		// Faster query when values can only take two distinct values
		biConditionalFilter(terms, conditions, relation, fieldName, useFts);
		return;
	}

	const tableName = useFts ? 'notes_normalized' : 'notes';

	const getCondition = (term: Term) => {
		if (fieldName === 'sourceurl') {
			return searchGenericCondition('sourceurl', tableName, null, term.negated, term.value);
		} else if (fieldName === 'date' && term.name === 'due') {
			return searchGenericCondition('due', tableName, null, term.negated, term.value);
		} else if (fieldName === 'id') {
			return searchGenericCondition('id', tableName, null, term.negated, term.value);
		} else {
			return searchGenericCondition('field', tableName, fieldName === 'date' ? `user_${term.name}_time` : `${term.name}`, term.negated, term.value);
		}
	};

	for (const term of terms) {
		conditions.push(searchGenericFilter(relation, term.name === 'due', tableName, getCondition(term)));
	}
};

const biConditionalFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, filterName: string, useFts: boolean) => {
	const getCondition = (filterName: string, value: string, relation: Relation) => {
		const tableName = useFts ? (relation === 'AND' ? 'notes_fts' : 'notes_normalized') : 'notes';
		if (filterName === 'type') {
			return searchIsTodoCondition(tableName, value === 'todo');
		} else if (filterName === 'iscompleted') {
			return searchIsCompletedCondition(tableName, value === '1');
		} else {
			throw new Error('Invalid filter name.');
		}
	};

	const values = terms.map(x => x.value);

	// AND and OR are handled differently because FTS restricts how OR can be used.
	for (const value of values) {
		if (relation === 'AND') {
			conditions.push(searchAndCondition(getCondition(filterName, value, relation)));
		}
		if (relation === 'OR') {
			if (useFts) {
				conditions.push(searchOrNormalizedCondition(getCondition(filterName, value, relation)));
			} else {
				conditions.push(searchOrCondition(getCondition(filterName, value, relation)));
			}
		}
	}
};

const noteIdFilter = (terms: Term[], state: QueryState, relation: Relation, useFts: boolean) => {
	const noteIdTerms = terms.filter(x => x.name === 'id');
	state.idParamCount += noteIdTerms.length;
	genericFilter(noteIdTerms, state.conditions, relation, 'id', useFts);
};


const typeFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
	const typeTerms = terms.filter(x => x.name === 'type');
	genericFilter(typeTerms, conditions, relation, 'type', useFts);
};

const completedFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
	const completedTerms = terms.filter(x => x.name === 'iscompleted');
	genericFilter(completedTerms, conditions, relation, 'iscompleted', useFts);
};


const locationFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
	const locationTerms = terms.filter(x => x.name === 'latitude' || x.name === 'longitude' || x.name === 'altitude');
	genericFilter(locationTerms, conditions, relation, 'location', useFts);
};

const dateFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
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
	genericFilter(unixDateTerms, conditions, relation, 'date', useFts);
};

const sourceUrlFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
	const urlTerms = terms.filter(x => x.name === 'sourceurl');
	genericFilter(urlTerms, conditions, relation, 'sourceurl', useFts);
};

const trimQuotes = (str: string) => str.startsWith('"') && str.endsWith('"') ? str.substr(1, str.length - 2) : str;

const textFilter = (terms: Term[], conditions: SearchFragment[], relation: Relation, useFts: boolean) => {
	const createLikeMatch = (term: Term, negate: boolean) => {
		const param = `%${trimQuotes(term.value).replace(/\*/, '%')}%`;
		conditions.push(searchLikeMatch(relation, negate, term.name, param));
	};

	const addExcludeTextConditions = (excludedTerms: Term[], conditions: SearchFragment[], relation: Relation) => {
		if (useFts) {
			const type = excludedTerms[0].name === 'text' ? '' : `.${excludedTerms[0].name}`;
			if (relation === 'AND') {
				conditions.push(searchFtsExcludeAnd(type, excludedTerms.map(x => x.value).join(' OR ')));
			}
			if (relation === 'OR') {
				for (const term of excludedTerms) {
					conditions.push(searchFtsExcludeOr(type, term.value));
				}
			}
		} else {
			for (const term of excludedTerms) {
				createLikeMatch(term, true);
			}
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
			conditions.push(searchFtsMatch(relation, matchQuery));
		} else {
			for (const term of includedTerms) {
				createLikeMatch(term, false);
			}
		}
	}

	const excludedTextTerms = allTerms.filter(x => x.name === 'text' && x.negated);
	const excludedTitleTerms = allTerms.filter(x => x.name === 'title' && x.negated);
	const excludedBodyTerms = allTerms.filter(x => x.name === 'body' && x.negated);

	if ((excludedTextTerms.length > 0)) {
		addExcludeTextConditions(excludedTextTerms, conditions, relation);
	}

	if (excludedTitleTerms.length > 0) {
		addExcludeTextConditions(excludedTitleTerms, conditions, relation);
	}

	if (excludedBodyTerms.length > 0) {
		addExcludeTextConditions(excludedBodyTerms, conditions, relation);
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
	const state: QueryState = { conditions: [], withs: [], withParamCount: 0, idParamCount: 0 };
	const queryParts = state.conditions;

	const relation: Relation = getDefaultRelation(terms);

	const tableName = useFts ? 'notes_fts' : 'notes';

	queryParts.push(searchSelectHead(tableName, useFts, getConnective(terms, relation)));

	noteIdFilter(terms, state, relation, useFts);

	notebookFilter(terms, state, useFts);

	tagFilter(terms, state, relation, useFts);

	resourceFilter(terms, state, relation, useFts);

	textFilter(terms, queryParts, relation, useFts);


	typeFilter(terms, queryParts, relation, useFts);

	completedFilter(terms, queryParts, relation, useFts);

	dateFilter(terms, queryParts, relation, useFts);

	locationFilter(terms, queryParts, relation, useFts);

	sourceUrlFilter(terms, queryParts, relation, useFts);

	let query;
	if (state.withs.length > 0) {
		if (terms.find(x => x.name === 'notebook') && terms.find(x => x.name === 'any')) {
			// The notebook filter should be independent of the any filter.
			// So we're first finding the OR of other filters and then combining them with the notebook filter using AND
			// in-required-notebook AND (condition #1 OR condition #2  OR ... )
			const body = searchNotebookFilterBody(joinSearchFragments(queryParts.slice(0, 2), ' '), joinSearchFragments(queryParts.slice(2), ' '));
			query = searchWithRecursive(state.withs, body);
		} else {
			query = searchWithRecursive(state.withs, joinSearchFragments(queryParts, ' '));
		}
	} else {
		query = joinSearchFragments(queryParts, ' ');
	}

	const compiled = toSqlQuery(compileSearchFragment(query));

	// Quirk kept on purpose (MIGRATION_PLAN Q4): the id: values used to be bound before the
	// notebook/tag/resource values even though the WITH clauses holding those come first.
	const withParams = compiled.params.slice(0, state.withParamCount);
	const idParams = compiled.params.slice(state.withParamCount, state.withParamCount + state.idParamCount);
	const params = [...idParams, ...withParams, ...compiled.params.slice(state.withParamCount + state.idParamCount)] as string[];

	return { query: compiled.sql, params };
}
