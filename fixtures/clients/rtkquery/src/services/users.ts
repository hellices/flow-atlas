// Endpoints injected into the central API slice, as RTK Query's code-splitting guide does.
import { api } from './api'

export interface User {
  id: string
  name: string
}

export const usersApi = api.injectEndpoints({
  endpoints: (build) => ({
    getUser: build.query<User, string>({
      query: (id) => `users/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'User', id }],
    }),
    searchUsers: build.query<User[], string>({
      query: (term) => ({ url: 'users/search', params: { q: term } }),
    }),
    followUser: build.mutation<void, string>({
      query: (id) => ({
        url: `users/${id}/follow`,
        method: 'POST',
        headers: { 'X-Source': 'profile' },
      }),
      invalidatesTags: (_result, _error, id) => [{ type: 'User', id }],
    }),
  }),
  overrideExisting: false,
})

export const { useGetUserQuery, useSearchUsersQuery, useFollowUserMutation } = usersApi
