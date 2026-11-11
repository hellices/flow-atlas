import { useLingui } from "@lingui/react/macro";

export const BillingInfo = ({ monthly }: { monthly: boolean }) => {
  const { t } = useLingui();
  const subtitle = monthly ? t`/month` : t`/month billed annually`;
  return <span>{subtitle}</span>;
};
