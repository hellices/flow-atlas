import axios from 'axios';

export async function invite(email: string) {
  return axios.post('/api/users', { email });
}

export async function backendIsUp() {
  const response = await fetch('/api/rest/rest-check');
  return response.ok;
}
