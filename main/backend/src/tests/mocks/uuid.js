const crypto = require('crypto');

module.exports = {
  v4: () => crypto.randomUUID(),
  v1: () => crypto.randomUUID(),
  v3: () => crypto.randomUUID(),
  v5: () => crypto.randomUUID(),
  v6: () => crypto.randomUUID(),
  v7: () => crypto.randomUUID(),
  validate: (str) => typeof str === 'string' && str.length === 36,
  stringify: (buf) => Buffer.from(buf).toString('hex'),
  parse: (str) => Buffer.from(str.replace(/-/g, ''), 'hex'),
  NIL: '00000000-0000-0000-0000-000000000000',
  MAX: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};
