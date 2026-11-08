// The app's central API slice, as RTK Query's guide sets one up: one base URL for every endpoint below, the auth
// header added to each request, and more endpoints injected from other files (users.ts).
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { RootState } from '../store'

export interface Post {
  id: string
  title: string
  body: string
}

export interface Comment {
  id: string
  text: string
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api/',
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.token
      if (token) headers.set('authorization', `Bearer ${token}`)
      return headers
    },
  }),
  tagTypes: ['Post', 'User'],
  endpoints: (build) => ({
    getHealth: build.query<{ status: string }, void>({
      query: () => '/health',
    }),
    getPosts: build.query<Post[], number>({
      query: (page) => ({ url: 'posts', params: { page, limit: 20 } }),
      providesTags: ['Post'],
    }),
    getPost: build.query<Post, string>({
      query: (id) => `posts/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Post', id }],
    }),
    addPost: build.mutation<Post, Partial<Post>>({
      query: (body) => ({
        url: 'posts',
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Post'],
    }),
    updatePost: build.mutation<Post, Pick<Post, 'id'> & Partial<Post>>({
      query: ({ id, ...patch }) => ({
        url: `posts/${id}`,
        method: 'PATCH',
        body: patch,
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Post', id }],
    }),
    replacePost: build.mutation<Post, Post>({
      query: (post) => ({ url: `posts/${post.id}`, method: 'PUT', body: post }),
    }),
    deletePost: build.mutation<{ success: boolean; id: string }, string>({
      query(id) {
        return {
          url: `posts/${id}`,
          method: 'DELETE',
        }
      },
      invalidatesTags: ['Post'],
    }),
    getPostComments: build.infiniteQuery<Comment[], string, number>({
      infiniteQueryOptions: {
        initialPageParam: 1,
        getNextPageParam: (lastPage, _allPages, lastPageParam) => (lastPage.length ? lastPageParam + 1 : undefined),
      },
      query: ({ queryArg, pageParam }) => `posts/${queryArg}/comments?page=${pageParam}`,
    }),
  }),
})

export const {
  useGetHealthQuery,
  useGetPostsQuery,
  useGetPostQuery,
  useAddPostMutation,
  useUpdatePostMutation,
  useReplacePostMutation,
  useDeletePostMutation,
  useGetPostCommentsInfiniteQuery,
} = api
