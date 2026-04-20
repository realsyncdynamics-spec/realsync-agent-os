'use strict';

module.exports = {
  env: {
    node:   true,
    es2021: true,
  },
  extends: 'eslint:recommended',
  parserOptions: {
    ecmaVersion: 'latest',
  },
  rules: {
    'no-unused-vars': 'warn',
    'no-console':     'off',
  },
  overrides: [
    {
      // Jest test files — enable jest globals
      files: ['src/__tests__/**/*.js', '**/*.test.js', '**/*.spec.js'],
      env: {
        jest: true,
      },
      rules: {
        'no-unused-vars': 'warn',
      },
    },
  ],
};
