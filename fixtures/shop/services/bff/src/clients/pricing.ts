export async function quote(http: any, pricingUrl: string) {
  return http.get(`${pricingUrl}/quotes`);
}
