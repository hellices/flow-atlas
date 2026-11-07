import { createFileRoute, Link as RouterLink, redirect } from "@tanstack/react-router"

import useAuth, { isLoggedIn } from "@/hooks/useAuth"

export const Route = createFileRoute("/login")({
  component: Login,
  beforeLoad: async () => {
    if (isLoggedIn()) {
      throw redirect({
        to: "/",
      })
    }
  },
})

function Login() {
  const { loginMutation } = useAuth()
  return (
    <form onSubmit={(e) => { e.preventDefault(); loginMutation.mutate(new FormData(e.currentTarget)) }}>
      <RouterLink to="/signup">Sign up</RouterLink>
    </form>
  )
}
