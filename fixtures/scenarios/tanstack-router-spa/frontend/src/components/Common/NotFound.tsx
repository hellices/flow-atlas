import { Link } from "@tanstack/react-router"

const NotFound = () => {
  return (
    <div data-testid="not-found">
      <p>The page you are looking for was not found.</p>
      <Link to="/">Go Back</Link>
    </div>
  )
}

export default NotFound
