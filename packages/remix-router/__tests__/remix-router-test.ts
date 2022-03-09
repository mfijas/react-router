import { createMemoryHistory } from "history";
import { createRemixRouter } from "../index";

// type Deferred = ReturnType<typeof defer>;

function defer() {
  let resolve: (val?: any) => Promise<void>;
  let reject: (error?: Error) => Promise<void>;
  let promise = new Promise((res, rej) => {
    resolve = async (val: any) => {
      res(val);
      await (async () => promise)();
    };
    reject = async (error?: Error) => {
      rej(error);
      await (async () => promise)();
    };
  });
  return { promise, resolve, reject };
}

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
        id: "root",
        element: null,
        path: "/",
        children: [
          {
            id: "index",
            element: null,
            index: true,
          },
          {
            id: "todos",
            element: null,
            path: "todos",
          },
          {
            id: "todos/id",
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
        exception: null,
        loaderData: null,
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: {
          location: undefined,
          state: "idle",
          submission: undefined,
          type: "idle",
        },
      });

      router.navigate("/todos");
      expect(router.state).toEqual({
        action: "PUSH",
        actionData: null,
        exception: null,
        loaderData: null,
        location: {
          pathname: "/todos",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: {
          location: undefined,
          state: "idle",
          submission: undefined,
          type: "idle",
        },
      });

      router.navigate("/todos/1", { replace: true });
      expect(router.state).toEqual({
        action: "REPLACE",
        actionData: null,
        exception: null,
        loaderData: null,
        location: {
          pathname: "/todos/1",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: {
          location: undefined,
          state: "idle",
          submission: undefined,
          type: "idle",
        },
      });

      history.go(-1);
      expect(router.state).toEqual({
        action: "POP",
        actionData: null,
        exception: null,
        loaderData: null,
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: {
          location: undefined,
          state: "idle",
          submission: undefined,
          type: "idle",
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

    it("executes loaders on navigations", async () => {
      let deferred = defer();
      let deferred2 = defer();

      let loaderRoutes = [
        {
          id: "root",
          element: null,
          path: "/",
          loader: () => deferred.promise,
          children: [
            {
              id: "index",
              element: null,
              index: true,
              loader: () => deferred2.promise,
            },
            {
              id: "todos",
              element: null,
              path: "todos",
            },
            {
              id: "todos/id",
              element: null,
              path: "todos/:id",
            },
          ],
        },
      ];

      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes: loaderRoutes });
      expect(router.state.transition).toEqual({
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        state: "loading",
        submission: undefined,
        type: "normalLoad",
      });
      expect(router.state.loaderData).toEqual({});
      await deferred.resolve("ROOT_DATA");
      await new Promise((r) => setTimeout(r, 0));
      expect(router.state.transition).toEqual({
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        state: "loading",
        submission: undefined,
        type: "normalLoad",
      });
      expect(router.state.loaderData).toEqual({});
      await deferred2.resolve("INDEX_DATA");
      await new Promise((r) => setTimeout(r, 0));
      expect(router.state.transition).toEqual({
        location: undefined,
        state: "idle",
        submission: undefined,
        type: "idle",
      });
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        index: "INDEX_DATA",
      });
    });
  });
});
