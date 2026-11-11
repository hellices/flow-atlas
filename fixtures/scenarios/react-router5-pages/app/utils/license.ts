import { PUBLIC_PAY_HOST } from "~/env";

export const getActivationKey = async (licenseKey: string): Promise<string> => {
  const response = await fetch(new URL(`/api/v1/activate/${licenseKey}`, PUBLIC_PAY_HOST).href);
  return response.text();
};
