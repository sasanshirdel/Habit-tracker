import type { Linter } from 'eslint';

/** Shared flat ESLint config for all workspace packages. */
declare const config: Linter.Config[];
export default config;

/** Regex source matching physical left/right Tailwind utilities (ADR-0004, P1-10). */
export declare const PHYSICAL_DIRECTION_CLASS: string;

/** `no-restricted-syntax` entries enforcing logical utilities in class names. */
export declare const logicalCssRestrictions: Array<{ selector: string; message: string }>;
