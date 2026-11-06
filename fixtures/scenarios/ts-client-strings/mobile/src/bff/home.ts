import type { BffClient } from "./http";

interface Asset {
  url: string;
}

interface Card {
  assetId: string;
}

interface Device {
  id: string;
  assetId: string;
}

/** The asset a response refers to; the endpoint that answered names the response in the error. */
function requireAsset(assets: ReadonlyMap<string, Asset>, assetId: string, endpoint: string): Asset {
  const value = assets.get(assetId);
  if (value === undefined) throw new Error(`${endpoint} refers to missing asset ${assetId}`);
  return value;
}

export class HomeAdapter {
  constructor(private readonly client: BffClient) {}

  async feed(assets: ReadonlyMap<string, Asset>): Promise<Asset[]> {
    const page = await this.client.request<{ cards: Card[] }>({ path: "/feed" });
    return page.cards.map((card) => requireAsset(assets, card.assetId, "/feed"));
  }

  devices(assets: ReadonlyMap<string, Asset>, devices: Device[]): Asset[] {
    return devices.map((device) => requireAsset(assets, device.assetId, "/devices"));
  }

  status(deviceId: string): Promise<{ online: boolean }> {
    return this.client.request({ path: `/devices/${encodeURIComponent(deviceId)}/status` });
  }

  interact(text: string): Promise<{ accepted: boolean }> {
    return this.client.request({ path: "/interactions", method: "POST", body: { text } });
  }
}
