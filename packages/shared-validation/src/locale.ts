import { locales } from '@habit/localization';
import { z } from 'zod';

/** A supported UI/content locale (`en` | `fa`), e.g. a user's language preference. */
export const localeSchema = z.enum(locales);
