// Jest transformer that converts ES modules from node_modules to CommonJS, for
// packages such as Kysely that are only published as ES modules. Jest does not
// support requiring ES modules from CommonJS code.

const ts = require('typescript');
const crypto = require('crypto');

module.exports = {
	process(sourceText, sourcePath) {
		const output = ts.transpileModule(sourceText, {
			fileName: sourcePath,
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				allowJs: true,
				sourceMap: false,
			},
		});
		return { code: output.outputText };
	},

	getCacheKey(sourceText, sourcePath) {
		return crypto.createHash('sha1').update(sourceText).update(sourcePath).update(ts.version).digest('hex');
	},
};
