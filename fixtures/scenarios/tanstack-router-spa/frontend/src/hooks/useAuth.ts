import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { LoginService, UsersService } from "@/client"

const isLoggedIn = () => {
  return localStorage.getItem("access_token") !== null
}

const useAuth = () => {
  const navigate = useNavigate()

  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => (await UsersService.readUserMe()).data,
    enabled: isLoggedIn(),
  })

  const signUpMutation = useMutation({
    mutationFn: (data: FormData) => UsersService.registerUser({ body: data }),
    onSuccess: () => {
      navigate({ to: "/login" })
    },
  })

  const loginMutation = useMutation({
    mutationFn: async (data: FormData) => {
      const response = await LoginService.loginAccessToken({ body: data })
      localStorage.setItem("access_token", response.data.access_token)
    },
    onSuccess: () => {
      navigate({ to: "/" })
    },
  })

  const logout = () => {
    localStorage.removeItem("access_token")
    navigate({ to: "/login" })
  }

  return { signUpMutation, loginMutation, logout, user }
}

export { isLoggedIn }
export default useAuth
