const fs = require('node:fs');
const path = require('node:path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const uriFile = path.join(__dirname, '.mongo-uri');

module.exports = async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replSet.getUri('kairali-jest');
  fs.writeFileSync(uriFile, uri, 'utf8');
  // Keep the process-local handle for teardown via global config path.
  globalThis.__KAIRALI_MONGO_REPLSET__ = replSet;
  // Jest globalSetup runs in a separate process; persist via file only is enough for URI,
  // but we also write a pid marker so teardown can reconnect if needed.
  fs.writeFileSync(
    path.join(__dirname, '.mongo-meta.json'),
    JSON.stringify({ uri }),
    'utf8',
  );
  // Stash on a well-known export file for teardown in same jest worker process pattern:
  // globalSetup/teardown share memory via this module's require cache when Jest reuses process.
  const statePath = path.join(__dirname, '.mongo-state.cjs');
  fs.writeFileSync(
    statePath,
    `module.exports = { uri: ${JSON.stringify(uri)} };\n`,
    'utf8',
  );
  // Attach replSet to module for teardown when Jest keeps the same process (default).
  module.exports.__replSet = replSet;
};
