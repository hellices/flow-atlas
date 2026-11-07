import { createFileRoute, Link as RouterLink } from "@tanstack/react-router"

import useAuth from "@/hooks/useAuth"

export const Route = createFileRoute("/signup")({
  component: SignUp,
})

function SignUp() {
  const { signUpMutation } = useAuth()
  return (
    <form onSubmit={(e) => signUpMutation.mutate(new FormData(e.currentTarget))}>
      <RouterLink to="/login">Log in</RouterLink>
    </form>
  )
}
