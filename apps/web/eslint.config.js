import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import base from '@habit/config/eslint';

// eslint-config-next is not used: its bundled react/import/jsx-a11y plugins do not yet
// declare ESLint 10 support (ESLint 9 is end-of-life). See ADR-0001.
export default [
  ...base,
  nextPlugin.configs['core-web-vitals'],
  reactHooks.configs.flat.recommended,
  { ignores: ['.next/**', 'next-env.d.ts'] },
];
