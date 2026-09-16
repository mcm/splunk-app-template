import { useState } from "react";

import { apiGet, SplunkApiError, useSplunkUser } from "@splunkapp/react";

export default function HomePage() {
  const [number, setNumber] = useState<number>(0);
  const [error, setError] = useState<string>();

  const user = useSplunkUser();

  const getLuckyNumber = async () => {
    try {
      // Relative to this app's REST namespace, so this calls /services/my_splunk_app/d6.
      // apiPost/apiPut/apiPatch/apiDelete take the same paths and add the CSRF headers
      // splunkd requires on writes.
      const result = await apiGet<{ result: number }>("d6");
      setNumber(result.result);
    } catch (e) {
      setError(e instanceof SplunkApiError ? `${e.status}: ${e.message}` : String(e));
    }
  };

  return (
    <div className="w-full p-6">
      <h1>Hello, {user ? user.realname : "world"}!</h1>

      {number == 0 ? (
        <a onClick={getLuckyNumber}>Click here to get your lucky number</a>
      ) : (
        <p>Your lucky number is {number}!</p>
      )}

      {error && <p>Could not roll the die - {error}</p>}
    </div>
  );
}
