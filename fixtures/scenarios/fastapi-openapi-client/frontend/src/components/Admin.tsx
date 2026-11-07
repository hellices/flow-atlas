import { useMutation, useQuery } from "@tanstack/react-query"

import { UsersService } from "@/client"

export function Admin() {
  const { data } = useQuery({
    queryKey: ["users"],
    queryFn: () => UsersService.readUsers({ query: { skip: 0, limit: 100 } }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => UsersService.deleteUser({ path: { user_id: id } }),
  })
  return (
    <ul>
      {data?.data.data.map((user) => (
        <li key={user.id}>
          {user.email} <button onClick={() => remove.mutate(user.id)}>Delete</button>
        </li>
      ))}
    </ul>
  )
}
