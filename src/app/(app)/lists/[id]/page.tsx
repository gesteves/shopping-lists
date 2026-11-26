import { Suspense } from "react";
import { RequireUser } from "../../_components/require-user";
import { ListView } from "./list-view";

export default function ListPage() {
  return (
    <>
      <Suspense>
        <RequireUser />
      </Suspense>
      {/* useParams() reads the request, thus it needs a boundary. */}
      <Suspense>
        <ListView />
      </Suspense>
    </>
  );
}
