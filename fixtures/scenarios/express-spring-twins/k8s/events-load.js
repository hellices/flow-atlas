import http from "k6/http";

const BASE_URL = __ENV.TARGET_URL || "http://localhost:3000";

const endpoints = [
  { path: "/events/session", weight: 47 },
  { path: "/events/click", weight: 6 },
  { path: "/events/consent", weight: 1 },
];

export default function () {
  // Each endpoint by its weight.
  let pick = Math.random() * endpoints.reduce((sum, e) => sum + e.weight, 0);
  const ep = endpoints.find((e) => (pick -= e.weight) < 0) ?? endpoints[endpoints.length - 1];
  http.post(`${BASE_URL}${ep.path}`, JSON.stringify({}), { headers: { "content-type": "application/json" } });
}
