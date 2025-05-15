import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['dist', 'src/**/buildDomTree.ts'],
  typescript: true,
  stylistic: true,
  jsonc: false,
  rules: {
    'no-console': 'off',
    'unused-imports/no-unused-vars': 'off',
    'node/prefer-global/process': 'off',
    'ts/ban-ts-comment': 'off',
    'node/prefer-global/buffer': 'off',
    'jsdoc/check-param-names': 'off',
    'ts/consistent-type-imports': 'off',
    'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],
  },
})
