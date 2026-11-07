// A plugin made by a function taking its configuration.
import { Elysia } from "elysia";

export const version = (version = 1) => new Elysia().get("/version", version);
