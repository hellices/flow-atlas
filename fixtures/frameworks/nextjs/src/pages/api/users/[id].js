export default function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ id: req.query.id });
  if (req.method === "DELETE") return res.status(204).end();
  res.setHeader("Allow", ["GET", "DELETE"]);
  res.status(405).end();
}
