import { createApiClient } from './client';
import { API_BASE_URL } from './config';

/** The app's API client (P1-12). Phase 2 (P2-03) adds the `csrf` option here. */
export const api = createApiClient({ baseUrl: API_BASE_URL });
