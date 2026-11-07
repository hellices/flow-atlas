import { useEffect, useState } from 'react';

import { restRestCheckRetrieve } from '@/js/api';

const Home = () => {
  const [restCheck, setRestCheck] = useState<Awaited<ReturnType<typeof restRestCheckRetrieve>>>();

  useEffect(() => {
    async function onFetchRestCheck() {
      setRestCheck(await restRestCheckRetrieve());
    }
    onFetchRestCheck();
  }, []);

  return <p>{restCheck?.data?.message}</p>;
};

export default Home;
