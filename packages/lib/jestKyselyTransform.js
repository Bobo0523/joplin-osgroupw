// Kysely ships only as an ES module, while lib's tests run on CommonJS, so the kysely
// package is converted to CommonJS when Jest loads it.
const ts = require('typescript');

module.exports = {
	process: (sourceText, sourcePath) => {
		const output = ts.transpileModule(sourceText, {
			fileName: sourcePath,
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2020,
				sourceMap: false,
			},
		});
		return { code: output.outputText };
	},
};
