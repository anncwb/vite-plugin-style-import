import type { Plugin, ResolvedConfig } from 'vite';
import type { Lib, VitePluginComponentImport } from './types';
import { createFilter } from '@rollup/pluginutils';
import * as changeCase from 'change-case';
import { ChangeCaseType, LibraryNameChangeCase } from './types';

import { init, parse, ImportSpecifier } from 'es-module-lexer';
import MagicString from 'magic-string';
import path from 'path';
import { normalizePath } from 'vite';
import { debug as Debug } from 'debug';

const debug = Debug('vite-plugin-style-import');

export default (options: VitePluginComponentImport): Plugin => {
  const {
    include = ['**/*.vue', '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx'],
    exclude = 'node_modules/**',
    libs = [],
  } = options;

  const filter = createFilter(include, exclude);

  let needSourcemap = false;
  let viteConfig: undefined | ResolvedConfig

  debug('plugin options:', options);

  return {
    name: 'vite:style-import',
    configResolved(resolvedConfig) {
      viteConfig = resolvedConfig
      needSourcemap = resolvedConfig.isProduction && !!resolvedConfig.build.sourcemap;
      debug('plugin config:', resolvedConfig);
    },
    async transform(code, id) {
      if (!code || !filter(id) || !needTransform(code, libs)) {
        return null;
      }

      const getResult = (content: string) => {
        return {
          map: needSourcemap ? this.getCombinedSourcemap() : null,
          code: content,
        };
      };

      await init;

      let imports: ImportSpecifier[] = [];
      try {
        imports = parse(code)[0];
        debug('imports:', imports);
      } catch (e) {
        debug('imports-error:', e);
      }
      if (!imports.length) {
        return null;
      }

      let s: MagicString | undefined;
      const str = () => s || (s = new MagicString(code));
      for (let index = 0; index < imports.length; index++) {
        const { s: start, e: end, se, ss } = imports[index];
        const name = code.slice(start, end);
        if (!name) {
          continue;
        }
        const lib = getLib(name, libs);
        if (!lib) {
          continue;
        }
        const importStr = code.slice(ss, se);
        const exportVariables = transformImportVar(importStr);
        const importStrList = transformLibCss(lib, exportVariables);
        debug('prepend import str:', importStrList.join(''));
        /**
         * Replace components' import path with libDirectory for some "old" ui library in build mode
         * @example
         * ```js
         * import { ElButton } from 'element-plus'
         * // replace
         * import ElButton from 'element-plus/lib/button'
         * ```
         */
        if (lib.libDirectory && viteConfig?.command === 'build') {
          const importsRegExp = new RegExp(`import\s+\{.*\}\s+from\s+(\"|\')${lib.libDirectory}(\"|\')`, 'g');
          str()
            .overwrite(
              ss,
              se,
              importStr.replace(
                importsRegExp,
                exportVariables
                  .map(exportVar => `import ${exportVar} from "${lib.libraryName}/${lib.libDirectory}/${exportVar.toLowerCase()}"`)
                  .join('\n')
              )
            )
        }
        str().prepend(importStrList.join(''));
      }

      return getResult(str().toString());
    },
  };
};

// Generate the corresponding component css string array
function transformLibCss(lib: Lib, exportVariables: string[]) {
  const { libraryName, resolveStyle, esModule, libraryNameChangeCase = 'paramCase' } = lib;
  if (!resolveStyle || typeof resolveStyle !== 'function' || !libraryName) {
    return [];
  }
  const set = new Set();
  for (let index = 0; index < exportVariables.length; index++) {
    const name = getChangeCaseFileName(exportVariables[index], libraryNameChangeCase);

    let importStr = resolveStyle(name);
    if (esModule) {
      importStr = resolveNodeModules(importStr);
    }
    set.add(`import '${importStr}';`);
  }
  debug('import sets:', set.toString());
  return Array.from(set);
}

// Extract import variables
function transformImportVar(importStr: string) {
  if (!importStr) {
    return [];
  }

  const exportStr = importStr.replace('import', 'export').replace(/\s+as\s+\w+,?/g, ',');
  let exportVariables: string[] = [];
  try {
    exportVariables = parse(exportStr)[1];
    debug('exportVariables:', exportVariables);
  } catch (error) {
    console.error(error);
    debug('transformImportVar:', error);
  }
  return exportVariables;
}

function getLib(libraryName: string, libs: Lib[]) {
  return libs.find((item) => item.libraryName === libraryName);
}

// File name conversion style
function getChangeCaseFileName(importedName: string, libraryNameChangeCase: LibraryNameChangeCase) {
  try {
    return changeCase[libraryNameChangeCase as ChangeCaseType](importedName);
  } catch (error) {
    return importedName;
  }
}

// Do you need to process code
function needTransform(code: string, libs: Lib[]) {
  return !libs.every(({ libraryName }) => {
    return !new RegExp(`('${libraryName}')|("${libraryName}")`).test(code);
  });
}

function resolveNodeModules(...dir: string[]) {
  return normalizePath(path.join(process.cwd(), 'node_modules', ...dir));
}
