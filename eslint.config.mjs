import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['dist'],
  typescript: true,
  stylistic: true,
  jsonc: false,
  rules: {
    'no-console': 'off',
    'unused-imports/no-unused-vars': 'off',
    'node/prefer-global/process': 'off',
  },
})
