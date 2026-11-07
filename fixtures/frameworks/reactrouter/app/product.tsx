export function loader({ params }: { params: { categoryId: string; productId: string } }) {
  return params;
}
export default function Page() {
  return <h1>Product</h1>;
}
