/* eslint-disable id-denylist */

import { Expression, QueryCreator, SelectQueryBuilder, SqlBool } from 'kysely';
import time from '../../time';
import { dynamicConditionBuilder, DynamicSchema, dynamicQb, sql } from '../database/kysely';
import { Row } from '../../database';

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

type SelectQuery = SelectQueryBuilder<DynamicSchema, string, Row>;

interface Condition {
	relation: Relation;
	expression: Expression<SqlBool>;
}

interface CommonTableExpression {
	name: string;
	query: SelectQuery;
}

const eb = dynamicConditionBuilder();

const rowIdIn = (query: SelectQuery, negated = false) => {
	return eb('rowid', negated ? 'not in' : 'in', query);
};

const ftsMatch = (target: Expression<unknown>, value: string) => {
	return sql<SqlBool>`${target} MATCH ${value}`;
};

// The conditions used to be concatenated in a single SQL string, with each of
// them prefixed by AND or OR. Since AND has precedence over OR in SQL, this
// groups the conditions in the same way.
const combineConditions = (first: Expression<SqlBool>, conditions: Condition[]) => {
	const groups: Expression<SqlBool>[][] = [[first]];
	for (const condition of conditions) {
		if (condition.relation === Relation.OR) {
			groups.push([condition.expression]);
		} else {
			groups[groups.length - 1].push(condition.expression);
		}
	}
	return eb.or(groups.map(group => eb.and(group)));
};

const _notebookFilter = (notebooks: string[], requirement: Requirement, conditions: Condition[], withs: CommonTableExpression[], useFts: boolean) => {
	if (notebooks.length === 0) return;

	const relevantFolders = dynamicQb.selectFrom('folders')
		.select('id')
		.where(eb.or(notebooks.map(notebook => eb('folders.title', 'like', notebook))));

	const viewName: string = requirement === Requirement.EXCLUSION ? 'notebooks_not_in_scope' : 'notebooks_in_scope';
	const withInNotebook = dynamicQb.selectFrom('folders')
		.select('folders.id')
		.where('id', 'in', relevantFolders)
		.unionAll(dynamicQb
			.selectFrom('folders')
			.innerJoin(viewName, 'folders.parent_id', `${viewName}.id`)
			.select('folders.id'));

	const tableName: string = useFts ? 'notes_normalized' : 'notes';
	const notesInScope = dynamicQb.selectFrom(viewName)
		.innerJoin(tableName, `${viewName}.id`, `${tableName}.parent_id`)
		.select(`${tableName}.rowid`);

	withs.push({ name: `${viewName}(id)`, query: withInNotebook });
	conditions.push({ relation: Relation.AND, expression: rowIdIn(notesInScope, requirement === Requirement.EXCLUSION) });
};

const notebookFilter = (terms: Term[], conditions: Condition[], withs: CommonTableExpression[], useFts: boolean) => {
	const notebooksToInclude = terms.filter(x => x.name === 'notebook' && !x.negated).map(x => x.value);
	_notebookFilter(notebooksToInclude, Requirement.INCLUSION, conditions, withs, useFts);

	const notebooksToExclude = terms.filter(x => x.name === 'notebook' && x.negated).map(x => x.value);
	_notebookFilter(notebooksToExclude, Requirement.EXCLUSION, conditions, withs, useFts);
};



const getOperator = (requirement: Requirement, relation: Relation): Operation => {
	if (relation === 'AND' && requirement === 'INCLUSION') { return Operation.INTERSECT; } else { return Operation.UNION; }
};

const filterByTableName = (
	terms: Term[],
	conditions: Condition[],
	relation: Relation,
	noteIDs: (value: string)=> SelectQuery,
	requirement: Requirement,
	withs: CommonTableExpression[],
	tableName: string,
	useFts: boolean,
) => {
	const operator: Operation = getOperator(requirement, relation);

	const values = terms.map(x => x.value);

	const noteTableName = `note_${tableName}`;
	let withCondition: SelectQuery = null;

	if (relation === Relation.OR && requirement === Requirement.EXCLUSION) {
		// with_${requirement}_${tableName} is added to the names to make them unique
		const allNotesName = `all_notes_with_${requirement}_${tableName}`;
		withs.push({
			name: allNotesName,
			query: dynamicQb.selectFrom(noteTableName).select(`${noteTableName}.note_id as id`).distinct(),
		});

		const notesWithoutExcludedField = (value: string) => dynamicQb
			.selectFrom(dynamicQb.selectFrom(allNotesName).selectAll().except(noteIDs(value)).as('notes_without_excluded_field'))
			.selectAll();

		// We need notes without at least one excluded (tag/resource)
		withCondition = values.map(notesWithoutExcludedField).reduce((query, current) => query.union(current));
	} else {
		// Notes with any/all values depending upon relation and requirement
		withCondition = dynamicQb.selectFrom(noteTableName)
			.select(`${noteTableName}.note_id as id`)
			.where(sql<SqlBool>`${sql.lit(operator === Operation.INTERSECT ? 1 : 0)}`);

		for (const value of values) {
			withCondition = operator === Operation.INTERSECT ? withCondition.intersect(noteIDs(value)) : withCondition.union(noteIDs(value));
		}
	}

	// Get the ROWIDs that satisfy the condition so we can filter the result
	const cteName = `notes_with_${requirement}_${tableName}`;
	const targetTableName = useFts ? 'notes_normalized' : 'notes';
	const matchingRowIds = dynamicQb.selectFrom(cteName)
		.innerJoin(targetTableName, `${cteName}.id`, `${targetTableName}.id`)
		.select(`${targetTableName}.rowid`);

	withs.push({ name: cteName, query: withCondition });
	conditions.push({ relation, expression: rowIdIn(matchingRowIds, relation === Relation.AND && requirement === Requirement.EXCLUSION) });
};


const resourceFilter = (terms: Term[], conditions: Condition[], relation: Relation, withs: CommonTableExpression[], useFts: boolean) => {
	const tableName = 'resources';

	const noteIDsWithResource = (value: string) => dynamicQb.selectFrom('note_resources')
		.select('note_resources.note_id as id')
		.where('note_resources.is_associated', '=', sql.lit(1))
		.where('note_resources.resource_id', 'in', dynamicQb.selectFrom('resources').select('resources.id').where('resources.mime', 'like', value));

	const requiredResources = terms.filter(x => x.name === 'resource' && !x.negated);
	const excludedResources = terms.filter(x => x.name === 'resource' && x.negated);

	if (requiredResources.length > 0) {
		filterByTableName(requiredResources, conditions, relation, noteIDsWithResource, Requirement.INCLUSION, withs, tableName, useFts);
	}

	if (excludedResources.length > 0) {
		filterByTableName(excludedResources, conditions, relation, noteIDsWithResource, Requirement.EXCLUSION, withs, tableName, useFts);
	}
};

const tagFilter = (terms: Term[], conditions: Condition[], relation: Relation, withs: CommonTableExpression[], useFts: boolean) => {
	const tableName = 'tags';

	const noteIDsWithTag = (value: string) => dynamicQb.selectFrom('note_tags')
		.select('note_tags.note_id as id')
		.where('note_tags.tag_id', 'in', dynamicQb.selectFrom('tags').select('tags.id').where('tags.title', 'like', value));

	const requiredTags = terms.filter(x => x.name === 'tag' && !x.negated);
	const excludedTags = terms.filter(x => x.name === 'tag' && x.negated);

	if (requiredTags.length > 0) {
		filterByTableName(requiredTags, conditions, relation, noteIDsWithTag, Requirement.INCLUSION, withs, tableName, useFts);
	}

	if (excludedTags.length > 0) {
		filterByTableName(excludedTags, conditions, relation, noteIDsWithTag, Requirement.EXCLUSION, withs, tableName, useFts);
	}
};

const genericFilter = (terms: Term[], conditions: Condition[], relation: Relation, fieldName: string, useFts: boolean) => {
	if (fieldName === 'iscompleted' || fieldName === 'type') {
		// Faster query when values can only take two distinct values
		biConditionalFilter(terms, conditions, relation, fieldName, useFts);
		return;
	}

	const tableName = useFts ? 'notes_normalized' : 'notes';

	const getCondition = (term: Term) => {
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

	for (const term of terms) {
		const matchingRowIds = rowIdIn(dynamicQb.selectFrom(tableName).select('rowid').where(getCondition(term)));
		conditions.push({
			relation,
			expression: term.name === 'due' ? eb.and([eb('is_todo', 'is', sql.lit(1)), matchingRowIds]) : matchingRowIds,
		});
	}
};

const biConditionalFilter = (terms: Term[], conditions: Condition[], relation: Relation, filterName: string, useFts: boolean) => {
	const getCondition = (filterName: string, value: string, relation: Relation) => {
		const tableName = useFts ? (relation === 'AND' ? 'notes_fts' : 'notes_normalized') : 'notes';
		if (filterName === 'type') {
			return eb(`${tableName}.is_todo`, 'is', sql.lit(value === 'todo' ? 1 : 0));
		} else if (filterName === 'iscompleted') {
			return eb.and([
				eb(`${tableName}.is_todo`, 'is', sql.lit(1)),
				eb(`${tableName}.todo_completed`, value === '1' ? 'is not' : 'is', sql.lit(0)),
			]);
		} else {
			throw new Error('Invalid filter name.');
		}
	};

	const values = terms.map(x => x.value);

	// AND and OR are handled differently because FTS restricts how OR can be used.
	for (const value of values) {
		if (relation === 'AND') {
			conditions.push({ relation: Relation.AND, expression: getCondition(filterName, value, relation) });
		}
		if (relation === 'OR') {
			if (useFts) {
				conditions.push({
					relation: Relation.OR,
					expression: rowIdIn(dynamicQb.selectFrom('notes_normalized').select('rowid').where(getCondition(filterName, value, relation))),
				});
			} else {
				conditions.push({ relation: Relation.OR, expression: getCondition(filterName, value, relation) });
			}
		}
	}
};

const noteIdFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const noteIdTerms = terms.filter(x => x.name === 'id');
	genericFilter(noteIdTerms, conditions, relation, 'id', useFts);
};


const typeFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const typeTerms = terms.filter(x => x.name === 'type');
	genericFilter(typeTerms, conditions, relation, 'type', useFts);
};

const completedFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const completedTerms = terms.filter(x => x.name === 'iscompleted');
	genericFilter(completedTerms, conditions, relation, 'iscompleted', useFts);
};


const locationFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const locationTerms = terms.filter(x => x.name === 'latitude' || x.name === 'longitude' || x.name === 'altitude');
	genericFilter(locationTerms, conditions, relation, 'location', useFts);
};

const dateFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
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

const sourceUrlFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const urlTerms = terms.filter(x => x.name === 'sourceurl');
	genericFilter(urlTerms, conditions, relation, 'sourceurl', useFts);
};

const trimQuotes = (str: string) => str.startsWith('"') && str.endsWith('"') ? str.substr(1, str.length - 2) : str;

const textFilter = (terms: Term[], conditions: Condition[], relation: Relation, useFts: boolean) => {
	const createLikeMatch = (term: Term, negate: boolean) => {
		const param = `%${trimQuotes(term.value).replace(/\*/, '%')}%`;
		const likeConditions = [];
		if (term.name === 'text' || term.name === 'body') likeConditions.push(eb('notes.body', 'like', param));
		if (term.name === 'text' || term.name === 'title') likeConditions.push(eb('notes.title', 'like', param));
		const expression = eb.or(likeConditions);
		conditions.push({ relation, expression: negate ? eb.not(expression) : expression });
	};

	const addExcludeTextConditions = (excludedTerms: Term[], conditions: Condition[], relation: Relation) => {
		if (useFts) {
			const matchTarget = excludedTerms[0].name === 'text' ? sql.table('notes_fts') : sql.ref(`notes_fts.${excludedTerms[0].name}`);
			const matchingRowIds = (value: string) => dynamicQb.selectFrom('notes_fts').select('rowid').where(ftsMatch(matchTarget, value));
			if (relation === 'AND') {
				conditions.push({ relation: Relation.AND, expression: rowIdIn(matchingRowIds(excludedTerms.map(x => x.value).join(' OR ')), true) });
			}
			if (relation === 'OR') {
				for (const term of excludedTerms) {
					const nonMatchingRowIds = dynamicQb
						.selectFrom(dynamicQb.selectFrom('notes_fts').select('rowid').except(matchingRowIds(term.value)).as('non_matching_notes'))
						.selectAll();
					conditions.push({ relation: Relation.OR, expression: rowIdIn(nonMatchingRowIds) });
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
			conditions.push({ relation, expression: ftsMatch(sql.table('notes_fts'), matchQuery) });
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

const getConnective = (terms: Term[], relation: Relation): Expression<SqlBool> => {
	const notebookTerm = terms.find(x => x.name === 'notebook');
	// ROWID=-1 acts as 0 (something always false)
	return (!notebookTerm && (relation === 'OR')) ? eb('rowid', '=', sql.lit(-1)) : sql<SqlBool>`${sql.lit(1)}`;
};

export default function queryBuilder(terms: Term[], useFts: boolean) {
	const conditions: Condition[] = [];
	const withs: CommonTableExpression[] = [];

	const relation: Relation = getDefaultRelation(terms);

	const tableName = useFts ? 'notes_fts' : 'notes';

	noteIdFilter(terms, conditions, relation, useFts);

	notebookFilter(terms, conditions, withs, useFts);

	tagFilter(terms, conditions, relation, withs, useFts);

	resourceFilter(terms, conditions, relation, withs, useFts);

	textFilter(terms, conditions, relation, useFts);


	typeFilter(terms, conditions, relation, useFts);

	completedFilter(terms, conditions, relation, useFts);

	dateFilter(terms, conditions, relation, useFts);

	locationFilter(terms, conditions, relation, useFts);

	sourceUrlFilter(terms, conditions, relation, useFts);

	let where: Expression<SqlBool>;
	if (withs.length > 0 && terms.find(x => x.name === 'notebook') && terms.find(x => x.name === 'any')) {
		// The notebook filter should be independent of the any filter.
		// So we're first finding the OR of other filters and then combining them with the notebook filter using AND
		// in-required-notebook AND (condition #1 OR condition #2  OR ... )
		const otherConditions = combineConditions(eb(sql.lit(1), '=', sql.lit(0)), conditions.slice(1));
		where = combineConditions(getConnective(terms, relation), [
			conditions[0],
			{ relation: Relation.AND, expression: rowIdIn(dynamicQb.selectFrom('notes_fts').select('rowid').where(otherConditions)) },
		]);
	} else {
		where = combineConditions(getConnective(terms, relation), conditions);
	}

	let queryCreator: QueryCreator<DynamicSchema> = dynamicQb;
	for (const w of withs) {
		queryCreator = queryCreator.withRecursive(w.name, () => w.query) as unknown as QueryCreator<DynamicSchema>;
	}

	const ftsFields = useFts ? [
		eb.fn('offsets', [sql.table('notes_fts')]).as('offsets'),
		eb.fn('matchinfo', [sql.table('notes_fts'), sql.lit('pcnalx')]).as('matchinfo'),
	] : [];

	return queryCreator.selectFrom(tableName)
		.select([
			`${tableName}.id`,
			`${tableName}.title`,
			...ftsFields,
			`${tableName}.user_created_time`,
			`${tableName}.user_updated_time`,
			`${tableName}.is_todo`,
			`${tableName}.todo_completed`,
			`${tableName}.parent_id`,
		])
		.where(where);
}
