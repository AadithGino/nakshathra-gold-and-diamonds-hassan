const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve TypeScript sources when imports use NodeNext `.js` extensions.
 */
module.exports = (request, options) => {
  if (
    typeof request === 'string' &&
    (request.startsWith('.') || request.startsWith('/')) &&
    request.endsWith('.js')
  ) {
    const fromDir = options.basedir;
    const absoluteJs = path.resolve(fromDir, request);
    const absoluteTs = absoluteJs.replace(/\.js$/, '.ts');
    if (fs.existsSync(absoluteTs)) {
      return absoluteTs;
    }
  }
  return options.defaultResolver(request, options);
};
