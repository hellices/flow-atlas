import { formatInvoice } from "./format";

export function loader({ params }: { params: { id: string } }) {
  return { title: formatInvoice(params.id) };
}
export default function Page() {
  return <h1>Invoice</h1>;
}
