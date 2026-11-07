import { Link, useLoaderData } from 'react-router';

import TopNav from '@/js/components/TopNav';
import { makeLink } from '@/js/utils/navigation';

const Members = () => {
  const data = useLoaderData();
  const prev = makeLink(data.previous);
  const next = makeLink(data.next);

  return (
    <>
      <TopNav />
      <ul>
        {data.results.map((m: { id: number; email: string }) => (
          <li key={m.id}>{m.email}</li>
        ))}
      </ul>
      {prev && <Link to={prev}>Previous</Link>}
      {next && <Link to={next}>Next</Link>}
    </>
  );
};

export default Members;
