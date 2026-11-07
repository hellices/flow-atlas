import { createBrowserRouter } from 'react-router';

import { membersLoader } from '@/js/loaders/members';
import Home from '@/js/pages/Home';
import Members from '@/js/pages/Members';

const router = createBrowserRouter([
  { index: true, Component: Home },
  { path: '/members', Component: Members, loader: membersLoader },
]);

export default router;
