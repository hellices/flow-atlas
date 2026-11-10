// The axios instance orval's generated functions send their requests with (orval.config.ts's `mutator`), as orval's
// guide sets one up: the API's path on the page's origin as its base URL, an interceptor for the token.
import Axios, { type AxiosError, type AxiosRequestConfig } from "axios";

export const AXIOS_INSTANCE = Axios.create({ baseURL: "/api/v1" });

AXIOS_INSTANCE.interceptors.request.use((config) => {
  config.headers.Authorization = "Bearer token";
  return config;
});

export const customInstance = <T>(config: AxiosRequestConfig, options?: AxiosRequestConfig): Promise<T> =>
  AXIOS_INSTANCE({ ...config, ...options }).then(({ data }) => data);

export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
