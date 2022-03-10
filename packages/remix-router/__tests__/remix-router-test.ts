import { createMemoryHistory } from "history";
import { createRemixRouter } from "../index";
import { IDLE_TRANSITION } from "../transition";
import { RouteObject } from "../utils";

// TODO find a better way to handle this
console.debug = () => {};

const flushTasks = () => new Promise((r) => setImmediate(r)); // let router flush updates

type Deferred = ReturnType<typeof defer>;

// Routes passed into createTestHElpers should just have a boolean gor loader/action
// indicating they want a stub
type TestRouteObject = Pick<RouteObject, "id" | "index" | "path"> & {
  loader?: boolean;
  children?: TestRouteObject[];
};

// Enhanced route objects are what is passed to the router for testing,. as they
// have been enhanced with stubbed loaders and actions
type EnhancedRouteObject = Omit<TestRouteObject, "loader" | "children"> & {
  loader?: jest.Mock<Promise<unknown>, []>;
  children?: EnhancedRouteObject[];
};

// A helper that includes the Deferred and stubs for any loaders/actions for the
// route allowing fine-grained test execution
type RouteTestHelper = {
  loader?: Deferred & {
    stub: jest.Mock<Promise<unknown>, []>;
  };
};

type TestHelpers = {
  routes: EnhancedRouteObject[];
  helpers: Record<string, RouteTestHelper>;
};

function defer() {
  let resolve: (val?: any) => Promise<void>;
  let reject: (error?: Error) => Promise<void>;
  let promise = new Promise((res, rej) => {
    resolve = async (val: any) => {
      res(val);
      await (async () => promise)();
      await flushTasks();
    };
    reject = async (error?: Error) => {
      rej(error);
      await (async () => promise)();
      await flushTasks();
    };
  });
  return {
    promise,
    //@ts-ignore
    resolve,
    //@ts-ignore
    reject,
  };
}

// Enhance the incoming routes by adding loaders/actions as specified and
// return the updated routes and the associated route helpers
function createTestHelpers(plainRoutes: TestRouteObject[]): TestHelpers {
  let helpers: Record<string, any> = {};

  function enhanceRoutes(_routes: TestRouteObject[]) {
    return _routes.map((r) => {
      if (helpers[r.id]) {
        throw new Error(`Found duplicate route id: ${r.id}`);
      }
      let routeHelpers: RouteTestHelper = {};
      let enhancedRoute: EnhancedRouteObject = {
        ...r,
        loader: undefined,
        children: undefined,
      };
      if (r.loader) {
        let deferred = defer();
        let loaderStub = jest.fn(() => deferred.promise);
        Object.assign(routeHelpers, {
          loader: {
            ...deferred,
            stub: loaderStub,
          },
        });
        enhancedRoute.loader = loaderStub;
        if (r.children) {
          enhancedRoute.children = enhanceRoutes(r.children);
        }
      }
      helpers[r.id] = routeHelpers;
      return enhancedRoute;
    });
  }

  return {
    routes: enhanceRoutes(plainRoutes),
    helpers,
  };
}

// Reusable routes for a simple todo app, for test cases that don't want
// to create their own more complex routes
const TASK_ROUTES: TestRouteObject[] = [
  {
    id: "root",
    path: "/",
    loader: true,
    children: [
      {
        id: "index",
        index: true,
        loader: false,
      },
      {
        id: "tasks",
        path: "tasks",
        loader: true,
      },
      {
        id: "tasks/id",
        path: "tasks/:id",
        loader: true,
      },
    ],
  },
];

describe("a remix router", () => {
  describe("navigation", () => {
    it("navigates through a history stack without data loading", async () => {
      let { routes } = createTestHelpers([
        {
          id: "index",
          index: true,
        },
        {
          id: "tasks",
          path: "tasks",
        },
        {
          id: "tasks/id",
          path: "tasks/:id",
        },
      ]);
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });
      expect(router.state).toEqual({
        action: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
      });

      router.navigate("/tasks");
      await flushTasks();
      expect(router.state).toEqual({
        action: "PUSH",
        location: {
          pathname: "/tasks",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
      });

      router.navigate("/tasks/1", { replace: true });
      await flushTasks();
      expect(router.state).toEqual({
        action: "REPLACE",
        location: {
          pathname: "/tasks/1",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
      });

      await history.go(-1);
      await new Promise((r) => setTimeout(r, 0));
      expect(router.state).toEqual({
        action: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
      });
    });
  });

  describe("data loading", () => {
    it("executes loaders on navigations", async () => {
      let { routes, helpers } = createTestHelpers(TASK_ROUTES);
      let { root, tasks } = helpers;
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });

      // starts at / and kicks off initial data loads
      expect(router.state.action).toEqual("POP");
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
      expect(root?.loader?.stub).toHaveBeenCalledWith();
      expect(tasks?.loader?.stub).not.toHaveBeenCalled();

      // finish data loading and complete initial navigation
      await root?.loader?.resolve("ROOT_DATA");
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });

      // navigate to /tasks and kick off data loading
      // TODO: why does this promise from navigate never resolve?
      router.navigate("/tasks");
      await flushTasks();
      expect(root?.loader?.stub.mock.calls.length).toBe(1);
      expect(tasks?.loader?.stub).toHaveBeenCalledWith();
      expect(router.state.transition).toEqual({
        location: {
          pathname: "/tasks",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        state: "loading",
        submission: undefined,
        type: "normalLoad",
      });

      // finishes nested route loader and completes navigation
      await tasks?.loader?.resolve("TASKS_DATA");
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });
    });

    it("executes loaders on replace navigations", async () => {
      let { routes, helpers } = createTestHelpers(TASK_ROUTES);
      let { root, tasks } = helpers;
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });
      expect(router.state.transition.type).toEqual("normalLoad");

      await root?.loader?.resolve("ROOT_DATA");
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });

      // navigate to /tasks and kick off data loading
      router.navigate("/tasks", { replace: true });
      await flushTasks();
      expect(root?.loader?.stub.mock.calls.length).toBe(1);
      expect(tasks?.loader?.stub).toHaveBeenCalledWith();
      expect(router.state.transition.type).toEqual("normalLoad");

      // finishes nested route loader and completes navigation
      await tasks?.loader?.resolve("TASKS_DATA");
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });
    });

    it("executes loaders on go navigations", async () => {
      let { routes, helpers } = createTestHelpers(TASK_ROUTES);
      let { root, tasks } = helpers;
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRemixRouter({ history, routes });
      expect(router.state.transition.type).toEqual("normalLoad");

      await root?.loader?.resolve("ROOT_DATA");
      await flushTasks();
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });

      // navigate to /tasks and kick off data loading
      router.navigate("/tasks");
      await flushTasks();
      expect(root?.loader?.stub.mock.calls.length).toBe(1);
      expect(tasks?.loader?.stub).toHaveBeenCalledWith();
      expect(router.state.transition.type).toEqual("normalLoad");

      // finishes nested route loader and completes navigation
      await tasks?.loader?.resolve("TASKS_DATA");
      await flushTasks();
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });

      // navigate back to / - immediate transition
      router.go(-1);
      await flushTasks();
      expect(root?.loader?.stub.mock.calls.length).toBe(1);
      expect(tasks?.loader?.stub.mock.calls.length).toBe(1);
      expect(router.state.transition).toEqual(IDLE_TRANSITION);
      expect(router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
    });
  });
});
