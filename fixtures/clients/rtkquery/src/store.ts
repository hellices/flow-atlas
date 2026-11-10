import { configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { api } from './services/api'
import { reportsApi } from './services/reports'
import { authSlice } from './features/auth/authSlice'

export const store = configureStore({
  reducer: {
    [api.reducerPath]: api.reducer,
    [reportsApi.reducerPath]: reportsApi.reducer,
    auth: authSlice.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware, reportsApi.middleware),
})

setupListeners(store.dispatch)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
