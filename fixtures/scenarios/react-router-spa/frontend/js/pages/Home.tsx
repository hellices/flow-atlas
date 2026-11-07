import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { statusRetrieve } from '@/js/api/sdk.gen';
import TopNav from '@/js/components/TopNav';

const Home = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    statusRetrieve().then((response) => setStatus(response.data?.message));
  }, []);

  return (
    <>
      <TopNav />
      <p>{status}</p>
      <button type="button" onClick={() => navigate('/members')}>
        See the members
      </button>
    </>
  );
};

export default Home;
