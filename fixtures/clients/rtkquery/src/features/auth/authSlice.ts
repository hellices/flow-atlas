import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export const authSlice = createSlice({
  name: 'auth',
  initialState: { token: null as string | null },
  reducers: {
    setToken: (state, action: PayloadAction<string | null>) => {
      state.token = action.payload
    },
  },
})

export const { setToken } = authSlice.actions
