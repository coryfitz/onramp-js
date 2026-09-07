const fs = require('node:fs');
const {stripTypeScriptTypes} = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped runtime modules without requiring a generated app's
// React Native/Babel dependencies. Node 22.15+ provides the TypeScript stripper.
function loadRuntime(filename, exportNames, imports = {}, globals = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'runtime', filename),
    'utf8',
  );
  const javascript = stripTypeScriptTypes(source)
    .replace(/^import \{([^}]+)\} from '([^']+)';/gm,
      (_match, bindings, specifier) => `const {${bindings}} = imports[${JSON.stringify(specifier)}];`)
    .replace(/\bexport (?=(?:async )?(?:function|class|const)\b)/g, '');
  return vm.runInNewContext(
    `${javascript}\n;({${exportNames.join(',')}});`,
    {imports, Error, URL, AbortController, setTimeout, clearTimeout, ...globals},
    {filename},
  );
}

module.exports = {loadRuntime};
