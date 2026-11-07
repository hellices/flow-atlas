import { NavLink } from 'react-router';

const TopNav = () => {
  return (
    <header>
      <nav aria-label="Primary">
        <a className="brand" href="/">
          shop
        </a>
        <NavLink className="nav-link" end to="/">
          Home
        </NavLink>
        <NavLink className="nav-link" to="/members">
          Members
        </NavLink>
      </nav>
    </header>
  );
};

export default TopNav;
