'use client';

import type {
  AccountDeletionResponse,
  AccountRestoreResponse,
  UserDataExport,
} from '@habit/shared-types';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, csrfTokens, publicApi } from '@/lib/api/api';
import { dropUserData, sessionQueryKey, type SessionState } from '@/lib/auth/session';

/**
 * Data export, account deletion and restore from the browser (backlog P2-10, ADR-0025). The API
 * decides everything; these helpers only move the result to the user. Nothing here stores the
 * exported data or the password anywhere (no web storage, no logging, no query cache).
 */

/** `habit-tracker-data-2026-11-27.json`, like the API's `Content-Disposition`. */
export function exportFileName(exportedAt: string): string {
  return `habit-tracker-data-${exportedAt.slice(0, 10)}.json`;
}

/**
 * Hands a JSON document to the browser as a file download (an object URL on a temporary link,
 * revoked right after). The API is on another origin (ADR-0019), so a plain link could not carry
 * the CSRF header; fetching then saving keeps the export a CSRF-protected POST.
 */
export function saveJsonFile(document: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    window.document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before the URL dies.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** `POST /account/export` (CSRF-protected), then saves the file. */
export function useExportData() {
  return useMutation({
    mutationFn: async () => {
      const document = await api.post<UserDataExport>('/account/export');
      saveJsonFile(document, exportFileName(document.exportedAt));
      return { exportedAt: document.exportedAt };
    },
  });
}

/** Local sign-out after the API ended every session (deletion): drop all cached user data. */
function forgetAccount(queryClient: QueryClient): void {
  csrfTokens.remember(null);
  dropUserData(queryClient);
  queryClient.setQueryData<SessionState>(sessionQueryKey, () => ({
    status: 'signed-out',
    reason: 'account-deleted',
  }));
}

/**
 * `POST /account/deletion` with the current password. On success the API has ended every session
 * and cleared the cookie; local state is dropped and the session becomes "signed out because the
 * account was deleted", which `AuthGate` turns into the confirmation page. A wrong password is
 * `ApiError` `REAUTHENTICATION_FAILED`; the user stays signed in.
 */
export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      api.post<AccountDeletionResponse>('/account/deletion', { password }),
    onSuccess: () => forgetAccount(queryClient),
  });
}

/**
 * `POST /auth/account-restore` with the token from the emailed link (no session; CSRF-less client
 * like the other emailed-link pages). A dead link is `ApiError` `INVALID_TOKEN`.
 */
export async function restoreAccount(token: string): Promise<AccountRestoreResponse> {
  return publicApi.post<AccountRestoreResponse>('/auth/account-restore', { token });
}
