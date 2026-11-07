import { AxiosError } from 'axios';
import { redirectDocument } from 'react-router';

import { membersList } from '@/js/api/sdk.gen';

export async function membersLoader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 10);
  const offset = Number(url.searchParams.get('offset') || 0);
  try {
    const response = await membersList({ query: { limit, offset }, throwOnError: true });
    return response.data;
  } catch (error) {
    if (error instanceof AxiosError && (error.status === 401 || error.status === 403)) {
      const next = url.pathname + url.search + url.hash;
      throw redirectDocument(`/admin/login/?next=${encodeURIComponent(next)}`);
    }
    throw error;
  }
}
