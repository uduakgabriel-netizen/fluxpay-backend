const crypto = require('crypto');

module.exports = {
  nanoid: (size = 21) => crypto.randomBytes(size).toString('base64url').substring(0, size),
  customAlphabet: () => () => 'mocked-id',
};
