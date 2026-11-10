// A second API slice for another service, with its own base URL.
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

export interface Report {
  year: number
  total: number
}

export const reportsApi = createApi({
  reducerPath: 'reportsApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/v2/reports' }),
  endpoints: (build) => ({
    getReport: build.query<Report, number>({
      query: (year) => `${year}/summary`,
    }),
    exportReport: build.mutation<string, { year: number; format: string }>({
      query: ({ year, format }) => ({
        url: `${year}/export`,
        method: 'POST',
        params: { format },
        responseHandler: 'text',
      }),
    }),
  }),
})

export const { useGetReportQuery, useExportReportMutation } = reportsApi
