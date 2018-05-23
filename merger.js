function deepMerge(toMerge = {}, mergeWith = 'window', overwrite = false) {
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
      deepMerge(v, mergeWith[e], overwrite);
    } else if (overwrite) {
      mergeWith[e] = v;
    }
  });
  return mergeWith;
}

module.exports = {
  merge: deepMerge
};