// Requests made with axios itself, outside the instances: a request config handed to `axios` and to `axios.request`.
import axios from "axios";
import { config } from "./config.js";

export async function health() {
  const { data } = await axios({ method: "get", url: `${config.apiUrl}/health` });
  return data;
}

export async function version() {
  const { data } = await axios.request({ baseURL: config.apiUrl, url: "/version" });
  return data;
}
