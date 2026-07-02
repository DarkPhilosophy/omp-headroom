import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
    js.configs.recommended,
    prettier,
    {
        files: ['tests/**/*.mjs', '.scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                Bun: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // The extension is a mirrored artifact validated by `bun --check` + tests.
        ignores: ['extension/**', 'node_modules/**', 'venv/**'],
    },
];
