import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { type Body_login_login_access_token as AccessToken, LoginService, UsersService } from "@/client"

const isLoggedIn = () => localStorage.getItem("access_token") !== null

const useAuth = () => {
  const navigate = useNavigate()
  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => UsersService.readUserMe(),
    enabled: isLoggedIn(),
  })

  const login = async (data: AccessToken) => {
    const response = await LoginService.loginAccessToken({ body: data })
    localStorage.setItem("access_token", response.data.access_token)
  }

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: () => navigate({ to: "/" }),
  })

  const logout = () => {
    localStorage.removeItem("access_token")
    navigate({ to: "/login" })
  }

  return { loginMutation, logout, user }
}

export { isLoggedIn }
export default useAuth
