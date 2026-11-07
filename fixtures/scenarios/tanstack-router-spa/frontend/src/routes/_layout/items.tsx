import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

import { ItemsService } from "@/client"

function getItemsQueryOptions() {
  return {
    queryFn: async () => (await ItemsService.readItems({ query: { skip: 0, limit: 100 } })).data,
    queryKey: ["items"],
  }
}

export const Route = createFileRoute("/_layout/items")({
  component: Items,
})

function Items() {
  const { data } = useSuspenseQuery(getItemsQueryOptions())
  return <ul>{data.data.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
}
