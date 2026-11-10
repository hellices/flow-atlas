// An API route answers every method; the handler tells them apart.
export default function handler(req, res) {
  res.status(200).json({ message: "Hello", method: req.method });
}
