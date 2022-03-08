import { createMemoryHistory } from "history";
import { createRemixRouter } from "../index";

describe("a remix router", () => {
  describe("navigation", () => {
    // Mimics the following with elements removed since they don't matter for RemixRouter
    //
    // <Routes>
    //   <Route path="/" element={<Layout />}>
    //     <Route index element={<Home />} />
    //     <Route path="todos" element={<Todos />} />
    //     <Route path="todo/:id" element={<Todo />} />
    //   </Route>
    // </Routes>
    let routes = [
      {
        element: null,
        path: "/",
        children: [
          {
            element: null,
            index: true,
          },
          {
            element: null,
            path: "todos",
          },
          {
            element: null,
            path: "todos/:id",
          },
        ],
      },
    ];

    it("navigates through a history stack", () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });
      expect(router.state).toEqual({
        action: "POP",
        actionData: null,
        catch: null,
        error: null,
        loaderData: null,
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
      });

      router.navigate("/todos");
      expect(router.state).toEqual({
        action: "PUSH",
        actionData: null,
        catch: null,
        error: null,
        loaderData: null,
        location: {
          pathname: "/todos",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
      });

      router.navigate("/todos/1", { replace: true });
      expect(router.state).toEqual({
        action: "REPLACE",
        actionData: null,
        catch: null,
        error: null,
        loaderData: null,
        location: {
          pathname: "/todos/1",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
      });

      history.go(-1);
      expect(router.state).toEqual({
        action: "POP",
        actionData: null,
        catch: null,
        error: null,
        loaderData: null,
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
      });
    });

    it("throws a 404 if a navigation path is not found", () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });
      expect(() => router.navigate("/junk")).toThrow(
        new Response(null, { status: 404 }).toString()
      );
    });
  });
});
