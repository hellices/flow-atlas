import { AxiosError } from 'axios';
import { redirectDocument } from 'react-router';

import { usersList } from '@/js/api';

export async function usersLoader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 10);
  try {
    const response = await usersList({ query: { limit }, throwOnError: true });
    return response.data;
  } catch (error) {
    if (error instanceof AxiosError && (error?.status === 401 || error?.status === 403)) {
      const next = url.pathname + url.search;
      throw redirectDocument(`/admin/login/?next=${encodeURIComponent(next)}`);
    }
    throw error;
  }
}
