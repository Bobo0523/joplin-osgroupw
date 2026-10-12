import { AnyQuery } from '../kysely';
import { schemaOcrAndItemsFtsV45 } from '../sqlFragments';

export default (): AnyQuery[] => {
	return schemaOcrAndItemsFtsV45();
};
