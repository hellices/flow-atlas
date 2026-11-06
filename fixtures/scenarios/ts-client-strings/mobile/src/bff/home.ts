import type { BffClient } from "./http";

interface Media {
  url: string;
}

interface Card {
  mediaId: string;
}

interface Device {
  id: string;
  mediaId: string;
}

/** The media a response refers to; the endpoint that answered names the response in the error. */
function requireMedia(media: ReadonlyMap<string, Media>, assetId: string, endpoint: string): Media {
  const value = media.get(assetId);
  if (value === undefined) throw new Error(`${endpoint} refers to missing media ${assetId}`);
  return value;
}

export class HomeAdapter {
  constructor(private readonly client: BffClient) {}

  async feed(media: ReadonlyMap<string, Media>): Promise<Media[]> {
    const page = await this.client.request<{ cards: Card[] }>({ path: "/feed" });
    return page.cards.map((card) => requireMedia(media, card.mediaId, "/feed"));
  }

  devices(media: ReadonlyMap<string, Media>, devices: Device[]): Media[] {
    return devices.map((device) => requireMedia(media, device.mediaId, "/devices"));
  }

  status(deviceId: string): Promise<{ online: boolean }> {
    return this.client.request({ path: `/devices/${encodeURIComponent(deviceId)}/status` });
  }

  interact(text: string): Promise<{ accepted: boolean }> {
    return this.client.request({ path: "/interactions", method: "POST", body: { text } });
  }
}
