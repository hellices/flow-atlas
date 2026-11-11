import { client } from "~/utils/ApiClient";

export default class DocumentsStore {
  async fetch(id: string) {
    const res = await client.post("/documents.info", { id });
    return res.data;
  }

  async fetchPage() {
    const res = await client.post("/documents.list");
    return res.data;
  }
}
