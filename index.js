var loaderUtils = require("loader-utils"),
    fs = require('fs'),
    pathUtil = require('path'),
	merge = require('deep-extend'),
    mapBuilder = require('./dependencyMapBuilder'),
    SourceNode = require("source-map").SourceNode,
    SourceMapConsumer = require("source-map").SourceMapConsumer,
    defaultConfig = config = {
        paths: [],
        es6mode: false,
        watch: true,
        fileExt: '.js'
    },
    prefix, postfix;

var timestampCache = {};
var sharedProvideMap = {};
var fileCache = {};


module.exports = function (source, inputSourceMap) {
    var self = this,
        query = this.query,
        callback = this.async(),
        originalSource = source,
        globalVars = [],
        exportedVars = [],
        config,
        enableCache,
        cacheToMemory = false,
        cachePath,
        rootPath;

    if (typeof query === 'string' &&  query.length > 0) {
        query = loaderUtils.parseQuery(this.query);
    }

    this.cacheable && this.cacheable();

    config = merge({}, defaultConfig, this.options ? [query.config || "closureLoader"] : {}, query);
    enableCache = !!config.cache;
    cacheToMemory = enableCache && config.cache == 'memory';
    if (enableCache && !cacheToMemory) {
        rootPath = config.root || (() => { throw 'root is required for file caching' })();
        cachePath = config.cachePath || (() => { throw 'cachePath is required when file caching enabled' })();
    }
    // enableCache && console.log('\nCache path', cachePath, '\nRoot path', rootPath);

    mapBuilder(config.paths, config.watch, config.fileExt).then(function(provideMap) {
        var modified,
            resourcePath = self.resource,
            cachedPath;

        if (enableCache) {
            if (!cacheToMemory) {
                var shortPath = resourcePath.startsWith(rootPath) ? resourcePath.substring(config.root.length) : resourcePath;
                shortPath.startsWith('/') && (shortPath = shortPath.substring(1));
                cachedPath = pathUtil.resolve(
                    cachePath,
                    shortPath
                );
                (cachedPath == resourcePath) && (() => { throw 'cachedPath should not be the same as resourcePath' })();
                !cachedPath.startsWith(cachePath) && (() => { throw 'cachedPath must begin with cachePath' })();
                // console.log('\nCaching', cachedPath);
            }
            try {
                // if (fs.existsSync(cachedPath)) {
                //     // console.log('\nFound in cache');
                //     var fileStat = fs.statSync(resourcePath);
                //     modified = fileStat.mtimeMs;
                //     if (timestampCache[resourcePath] == modified) {
                //         // console.log("\nMatched");
                //         if (!inputSourceMap || fs.existsSync(cachedPath + '.map')) {
                //             var cachedFileContent = fs.readFileSync(cachedPath);
                //             var cachedFileMap = inputSourceMap && fs.readFileSync(cachedPath + '.map');
                //             callback(null, cachedFileContent, cachedFileMap);
                //             return cachedFileContent;
                //         }
                //     }
                // }
                var shouldReturn = false;
                ifExistsInCache(resourcePath, cachedPath, function(exists) {
                    if (exists) {
                        // console.log(resourcePath, 'exists in cache');
                        var fileStat = fs.statSync(resourcePath);
                        modified = fileStat.mtimeMs;
                        compareCached(resourcePath, cachedPath, modified, inputSourceMap, function(matches, content) {
                            if (matches) {
                                // console.log(resourcePath, 'matched cache');
                                callback(null, content.file, content.map);
                                shouldReturn = true;
                            }
                        });
                    }
                });
                if (shouldReturn) { return; }
            } catch (ex) {
                // console.log("\n\nException\n", ex);
                throw ex;
            }
        }

        syncProvideMap(provideMap, false);

        var provideRegExp = /(?<!\/\/.*)goog\.provide *?\((['"])(.*?)\1\);?/,
            requireRegExp = /(?<!\/\/.*)goog\.require *?\((['"])(.*?)\1\);?/,
            globalVarTree = {},
            exportVarTree = {},
            requires      = {}
            matches;

        while (matches = provideRegExp.exec(source)) {
            source = source.replace(new RegExp(escapeRegExp(matches[0]), 'g'), '');
            globalVars.push(matches[2]);
            exportedVars.push(matches[2]);
        }

        while (matches = requireRegExp.exec(source)) {
            globalVars.push(matches[2]);
            source = replaceRequire(source, matches[2], matches[0], provideMap, exportedVars, requires);
        }

        globalVars = globalVars
            .filter(deduplicate)
            .map(buildVarTree(globalVarTree));

        exportedVars = exportedVars
            .filter(deduplicate)
            .filter(removeNested)
            .map(buildVarTree(exportVarTree));

        prefix = createPrefix(globalVarTree, requires);
        postfix = createPostfix(exportVarTree, exportedVars, config);

        var fileContent, mapContent;
        if(inputSourceMap) {
            var currentRequest = loaderUtils.getCurrentRequest(self),
                node = SourceNode.fromStringWithSourceMap(originalSource, new SourceMapConsumer(inputSourceMap));

            node.prepend(prefix + "\n");
            node.add(postfix);
            var result = node.toStringWithSourceMap({
                file: currentRequest
            });

            fileContent = prefix + "\n" + source + postfix;
            mapContent = result.map.toJSON();
            enableCache && cacheFileAndMap(resourcePath, cachedPath, modified, fileContent, mapContent);
            syncProvideMap(provideMap, true);
            callback(null, fileContent, mapContent);
        } else {
            fileContent = prefix + "\n" + source + postfix;
            enableCache && cacheFileAndMap(resourcePath, cachedPath, modified, fileContent, null);
            syncProvideMap(provideMap, true);
            callback(null, fileContent, inputSourceMap);
        }
        return fileContent;
    }).catch(function(error) {
      callback(error);
    });

    function cacheFileAndMap(resourcePath, cachedPath, sourceTimestamp, fileContent, mapContent) {
        if (!enableCache) { return false; }
        if (cacheToMemory) {
            fileCache[resourcePath] = {
                file: fileContent,
                map: mapContent,
                modified: sourceTimestamp
            };
            timestampCache[resourcePath] = sourceTimestamp;
        } else {
            try {
                fs.writeFileSync(ensurePath(cachedPath), fileContent);
                mapContent && fs.writeFileSync(cachedPath + '.map', mapContent);
                timestampCache[resourcePath] = sourceTimestamp;
            } catch (ex) {
                // console.log('\n\nException while trying to cache content\n', ex);
                throw ex;
            }
        }
    }
    function ensurePath(path) {
        var pathParts = path.split(/\//g);
        if (!path.endsWith('/')) { pathParts.pop(); }
        if (fs.existsSync(pathParts.join('/'))) { return path; }
        var checkPath;
        for (var i = 0; i < pathParts.length; i++) {
            if (!fs.existsSync(checkPath = pathParts.slice(0, i + 1).join('/') + '/')) {
                fs.mkdirSync(checkPath);
            }
        }
        return path;
    }
    function ifExistsInCache(resourcePath, cachedPath, callback) {
        if (!enableCache) { callback && callback(false); return false; }
        var exists = cacheToMemory ? (resourcePath in fileCache) : fs.existsSync(cachedPath);
        callback && callback(exists);
        return exists;
    }
    function compareCached(resourcePath, cachedPath, modified = null, inputSourceMap, callback) {
        if (!enableCache) { callback && callback(false); return false; }
        if (!modified) {
            var fileStat = fs.statSync(resourcePath);
            modified = fileStat.mtimeMs;
        }
        if (timestampCache[resourcePath] != modified) {
            delete timestampCache[resourcePath];
            if (cacheToMemory && (resourcePath in fileCache)) {
                delete fileCache[resourcePath];
            }
            callback && callback(false);
            return false;
        }
        if (cacheToMemory) {
            if (resourcePath in fileCache) {
                callback && callback(true, fileCache[resourcePath]);
                return fileCache[resourcePath];
            }
        } else {
            if (ifExistsInCache(resourcePath)) {
                if (!inputSourceMap || fs.existsSync(cachedPath)) {
                    var cachedFileContent = fs.readFileSync(cachedPath);
                    var cachedFileMap = fs.existsSync(cachedPath + '.map') && fs.readFileSync(cachedPath + '.map');
                    var reply = {
                        file: cachedFileContent,
                        map: cachedFileMap
                    };
                    callback && callback(true, reply);
                    return reply;
                }
            }
        }
        callback && callback(false);
        return false;
    }

    function syncProvideMap(provideMap, toShared) {
        toShared ?
            Object.keys(provideMap).forEach(k => sharedProvideMap[k] = provideMap[k])
            :
            Object.keys(sharedProvideMap).forEach(k => provideMap[k] = sharedProvideMap[k])
        ;
    }

    /**
     * Escape a string for usage in a regular expression
     *
     * @param {string} string
     * @returns {string}
     */
    function escapeRegExp(string) {
        return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
    }

    function isParent(key, exportedVars) {
        var isParent = false;
        var isParentRegExp = new RegExp('^' + key.split('.').join('\\.') + '\\.');
        for (var i=0; i < exportedVars.length; i++) {
            if (isParentRegExp.test(exportedVars[i])) return true;
        }
    }

    /**
     * Replace a given goog.require() with a CommonJS require() call.
     *
     * @param {string} source
     * @param {string} key
     * @param {string} search
     * @param {Object} provideMap
     * @returns {string}
     */
    function replaceRequire(source, key, search, provideMap, exportedVars, requires) {
        var replaceRegex = new RegExp(escapeRegExp(search), 'g');
        var path, pathKey, requireString;

        if (!provideMap[key]) {
            throw new Error("Can't find closure dependency " + key);
        }

        path = loaderUtils.stringifyRequest(self, provideMap[key]);
        // requireString = 'require(' + path + ').' + key;
        pathKey = getPathKey(path);
        requires[pathKey] = path.replace(/^"(.*)"$/, '$1');
        requireString = pathKey + '.' + key;

        // if the required module is a parent of a provided module, use deep-extend so that injected
        // namespaces are not overwritten
        if (isParent(key, exportedVars)) {
          // return source.replace(replaceRegex, key + '=__merge(' + requireString + ', (' + key + ' || {}));');
          return source.replace(replaceRegex, key + '=' + generateDeepMergeCode(requireString, `'${key}'`, false, true));
        } else {
          return source.replace(replaceRegex, key + '=' + requireString + ';');
        }
    }

    function getPathKey(path) {
        return path.replace(/[^a-z0-9_]/ig, '_');
    }

    /**
     * Array filter function to remove duplicates
     *
     * @param {string} key
     * @param {number} idx
     * @param {Array} arr
     * @returns {boolean}
     */
    function deduplicate(key, idx, arr) {
        return arr.indexOf(key) === idx;
    }

    /**
     * Array filter function to remove vars which already have a parent exposed
     *
     * Example: Remove a.b.c if a.b exists in the array
     *
     * @param {[type]} key [description]
     * @param {[type]} idx [description]
     * @param {[type]} arr [description]
     *
     * @returns {[type]} [description]
     */
    function removeNested(key, idx, arr) {
        var foundParent = false;

        key.split('.')
            .forEach(function (subKey, subIdx, keyParts) {
                var parentKey;
                if(subIdx === (keyParts.length - 1)) return;
                parentKey = keyParts.slice(0, subIdx + 1).join('.');
                foundParent = foundParent || arr.indexOf(parentKey) >= 0;
            });

        return !foundParent;
    }

    /**
     * Creates a function that extends an object based on an array of keys
     *
     * Example: `['abc.def', 'abc.def.ghi', 'jkl.mno']` will become `{abc: {def: {ghi: {}}, jkl: {mno: {}}}`
     *
     * @param {Object} tree - the object to extend
     * @returns {Function} The filter function to be called in forEach
     */
    function buildVarTree(tree) {
        return function (key) {
            var layer = tree;
            key.split('.').forEach(function (part) {
                layer[part] = layer[part] || {};
                layer = layer[part];
            });
            return key;
        }
    }

    /**
     * Create a string which will be injected after the actual module code
     *
     * This will create export statements for all provided namespaces as well as the default
     * export if es6mode is active.
     *
     * @param {Object} exportVarTree
     * @param {Array} exportedVars
     * @param {Object} config
     * @returns {string}
     */
    function createPostfix(exportVarTree, exportedVars, config) {
        postfix = '\n;';
        Object.keys(exportVarTree).forEach(function (rootVar) {
            var jsonObj;
            enrichExport(exportVarTree[rootVar], rootVar);
            jsonObj = JSON.stringify(exportVarTree[rootVar]).replace(/(['"])%(.*?)%\1/g, '$2');
	    if (jsonObj == '{}') {
                jsonObj = rootVar + ' || { empty: true } ';
            }
	    postfix += 'exports.' + rootVar + '=' + jsonObj + ';';
        });

        if (config.es6mode && exportedVars.length) {
            postfix += 'exports.default=' + exportedVars.shift() + ';exports.__esModule=true;';
        }

        return postfix;
    }

    /**
     * Generates the code necessary to deeply merge an object with an object of the specified name
     * 
     * @param {object} toMerge 
     * @param {string} mergeWith
     * @returns {string} 
     */
    function generateDeepMergeCode(toMerge = {}, mergeWith = 'window', overwrite = false, addTrailingSemicolon = false) {
        var serialized = toMerge.constructor == String ? toMerge : JSON.stringify(toMerge);
        var clientMerger =
        `(function() {
            var __merger = function(toMerge, mergeWith, overwrite) {
                if (!mergeWith) { throw 'Unable to merge with undefined object'; }
                if (mergeWith.constructor == String) { /* Ensure this exists */
                    if (mergeWith == 'window') { mergeWith = window; }
                    else {
                        var mergeParts = mergeWith.split(/\\./g);
                        var where = window;
                        mergeParts.map(function(w) {
                            if (!where[w]) {
                                where[w] = {};
                            }
                            if (!(where[w] instanceof Object)) { throw 'Invalid object'; }
                            where = where[w];
                        });
                        mergeWith = where;
                    }
                }
                var keys = Object.getOwnPropertyNames(toMerge);
                keys.map(function(e) {
                    var v = toMerge[e];
                    var isHash = v instanceof Object && !(v instanceof Function || v instanceof Array || (window.Symbol && v instanceof Symbol));
                    if (!mergeWith[e]) {
                        mergeWith[e] = v; /* We can skip further iteration of this branch */
                        return;
                    }
                    if (isHash) {
                        __merger(v, mergeWith[e], overwrite);
                    } else if (overwrite) {
                        mergeWith[e] = v;
                    }
                });
                return mergeWith;
            };
            return __merger(${serialized}, ${mergeWith}, ${overwrite});
        })()`;
        if (addTrailingSemicolon) { clientMerger += ';'; }
        return clientMerger;
    }

    /**
     * Create a string to inject before the actual module code
     *
     * This will create all provided or required namespaces. It will merge those namespaces into an existing
     * object if existent. The declarations will be executed via eval because other plugins or loaders like
     * the ProvidePlugin will see that a variable is created and might not work as expected.
     *
     * Example: If you require or provide a namespace under 'goog' and have the closure library export
     * its global goog object and use that via ProvidePlugin, the plugin wouldn't inject the goog variable
     * into a module that creates its own goog variables. That's why it has to be executed in eval.
     *
     * @param globalVarTree
     * @returns {string}
     */
    function createPrefix(globalVarTree, requires) {
        // var merge = " /** @export */ window.__merge = window.__merge || require(" + loaderUtils.stringifyRequest(self, require.resolve('deep-extend')) + ");";
        // prefix = '';
        // Object.keys(globalVarTree).forEach(function (rootVar) {
        //     prefix += [
        //         'var ',
        //         rootVar,
        //         '=__merge(',
        //         rootVar,
        //         '||__merge({}, window.',
        //         rootVar,
        //         '),',
        //         JSON.stringify(globalVarTree[rootVar]),
        //         ');'
        //     ].join('');
        // });

        // return merge + "eval('" +  prefix.replace(/'/g, "\\'") + "');";
        // var prefix = generateDeepMergeCode(globalVarTree, 'window', true, true);
        var prefix = 'window.__merge = window.__merge || require(' + loaderUtils.stringifyRequest(self, require.resolve("./merger.js")) + ').merge;\n';
        prefix += '__merge(' + JSON.stringify(globalVarTree) + ', window, true, true);\n';
        prefix += '\n' + Object.getOwnPropertyNames(requires).map(r =>
            'const ' + r + ' = require("' + requires[r] + '");'
        ).join('\n');
        return prefix;
    }

    /**
     * Replace all empty objects in an object tree with a special formatted string containing the path
     * of that empty object in the tree
     *
     * Example: `{abc: {def: {}}}` will become `{abc: {def: "%abc.def%"}}`
     *
     * @param {Object} object - The object tree to enhance
     * @param {string} path - The base path for the given object
     */
    function enrichExport(object, path) {
        path = path ? path + '.' : '';
        Object.keys(object).forEach(function (key) {
            var subPath = path + key;

            if (Object.keys(object[key]).length) {
                enrichExport(object[key], subPath);
            } else {
                object[key] = '%' + subPath + '%';
            }
        });
    }
};
