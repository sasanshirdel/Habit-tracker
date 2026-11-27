// First: zod settings that must precede every schema construction (browser CSP, see the module).
import './zod-config.js';

export { localeSchema } from './locale.js';
export { localDateSchema } from './local-date.js';
export { timeZoneSchema } from './time-zone.js';
export {
  CURSOR_MAX_LENGTH,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  paginationQuerySchema,
  type PaginationQuery,
} from './pagination.js';
export {
  EMAIL_MAX_LENGTH,
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_LINK_MINUTES,
  currentPasswordSchema,
  emailAddressSchema,
  newPasswordSchema,
  normalizePassword,
  passwordResetRequestSchema,
  passwordResetSchema,
  signInCredentialsSchema,
  signUpCredentialsSchema,
  type PasswordResetInput,
  type PasswordResetRequestInput,
  type SignInCredentials,
  type SignUpCredentials,
} from './credentials.js';
export {
  DISPLAY_NAME_INPUT_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  calendarSystemSchema,
  defaultDisplayPreferencesFor,
  displayNameSchema,
  normalizeDisplayName,
  preferencesSchema,
  preferencesUpdateSchema,
  profileUpdateSchema,
  themePreferenceSchema,
  weekStartSchema,
  type PreferencesInput,
  type PreferencesUpdate,
  type ProfileUpdate,
  type ProfileUpdateInput,
} from './profile.js';
