import { useState } from 'react';

import { SplunkPage } from '@/components/splunk/splunk-page';
import { getCurrentSplunkUser } from '@/components/splunk/splunk-current-user';

import "@/globals.css";
import { createRESTURL } from '@splunk/splunk-utils/url';

function HomePage() {
  const [number, setNumber] = useState<number>(0);

  const user = getCurrentSplunkUser();

  const getLuckyNumber = async () => {
    const url = createRESTURL("splunk_react18_asgi_example/d6");
    const response = await fetch(url);

    const result: { result: number } = await response.json();
    setNumber(result.result);
  }

  return (
    <div className="w-full p-6">
      <h1>Hello, {user ? user.realname : "world"}!</h1>

      {number == 0 ? <a onClick={getLuckyNumber}>Click here to get your lucky number</a> : <p>Your lucky number is {number}!</p>}
    </div>
  )
}
SplunkPage(<HomePage />)