const fs = require('node:fs');
const path = require('node:path');

module.exports = async function globalTeardown() {
  const setup = require('./global-setup.cjs');
  if (setup.__replSet) {
    await setup.__replSet.stop();
    setup.__replSet = undefined;
  }
  for (const file of ['.mongo-uri', '.mongo-meta.json', '.mongo-state.cjs']) {
    const full = path.join(__dirname, file);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
};
