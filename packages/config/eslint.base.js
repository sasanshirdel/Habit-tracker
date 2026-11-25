// Shared flat ESLint config for all workspace packages.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Physical-direction Tailwind utilities (`ml-2`, `pr-4`, `left-0`, `text-right`, `border-l`,
 * `rounded-tr-md`, with variants like `md:` or `!`). They do not mirror in RTL, so Persian
 * layouts break (ADR-0004). Use the logical ones instead: `ms-/me-`, `ps-/pe-`, `start-/end-`,
 * `text-start/end`, `border-s/e`, `rounded-s/e`, `float-start/end`.
 * No `/` in the pattern: ESLint selectors cannot contain one inside a regex.
 */
export const PHYSICAL_DIRECTION_CLASS =
  '(^|[\\s:!])-?(left-|right-|([mp][lr]|inset-[lr]|border-[lr]|rounded-([lr]|[tb][lr])|scroll-[mp][lr]|(text|float|clear)-(left|right))(-|\\s|$))';

const CLASS_CONTEXTS = [
  'JSXAttribute[name.name=/^(className|class)$/]',
  'CallExpression[callee.name=/^(cn|clsx|cva|twMerge|twJoin)$/]',
];
const physicalDirectionMessage =
  'Physical left/right utility: use a logical one (ms-/me-, ps-/pe-, start-/end-, text-start/end, border-s/e, rounded-s/e) so RTL mirrors (ADR-0004).';

/** `no-restricted-syntax` entries enforcing logical utilities in class names (backlog P1-10). */
export const logicalCssRestrictions = CLASS_CONTEXTS.flatMap((context) => [
  {
    selector: `${context} Literal[value=/${PHYSICAL_DIRECTION_CLASS}/]`,
    message: physicalDirectionMessage,
  },
  {
    selector: `${context} TemplateElement[value.raw=/${PHYSICAL_DIRECTION_CLASS}/]`,
    message: physicalDirectionMessage,
  },
]);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', ...logicalCssRestrictions],
    },
  },
);
