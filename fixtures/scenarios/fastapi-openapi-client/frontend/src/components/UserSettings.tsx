import { useMutation } from "@tanstack/react-query"

import { type UserUpdateMe, UsersService } from "@/client"
import useAuth from "@/hooks/useAuth"

export function UserSettings() {
  const { logout } = useAuth()
  const update = useMutation({
    mutationFn: (data: UserUpdateMe) => UsersService.updateUserMe({ body: data }),
  })
  const remove = useMutation({
    mutationFn: () => UsersService.deleteUserMe(),
    onSuccess: logout,
  })
  return (
    <section>
      <button onClick={() => update.mutate({ full_name: "" })}>Save</button>
      <button onClick={() => remove.mutate()}>Delete account</button>
    </section>
  )
}
