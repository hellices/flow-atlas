// A named plugin: used twice, Elysia registers its routes once.
import { Elysia } from "elysia";

export const health = new Elysia({ name: "health" }).get("/health", { status: "ok" });
