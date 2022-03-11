import { createMemoryHistory, History, InitialEntry } from "history";
import {
  createRemixRouter,
  HydrationState,
  NavigateOptions,
  RemixRouter,
} from "../index";
import { IDLE_TRANSITION } from "../transition";
import { invariant, LoaderFunctionArgs, RouteObject } from "../utils";

// TODO find a better way to handle this
console.debug = () => {};

///////////////////////////////////////////////////////////////////////////////
//#region Types and Utils
///////////////////////////////////////////////////////////////////////////////

type Deferred = ReturnType<typeof defer>;

// Routes passed into setup() should just have a boolean for loader/action
// indicating they want a stub
type TestRouteObject = Pick<RouteObject, "id" | "index" | "path"> & {
  loader?: boolean;
  exceptionElement?: boolean;
  children?: TestRouteObject[];
};

// Enhanced route objects are what is passed to the router for testing, as they
// have been enhanced with stubbed loaders and actions
type EnhancedRouteObject = Omit<TestRouteObject, "loader" | "children"> & {
  loader?: (args: LoaderFunctionArgs) => Promise<unknown>;
  children?: EnhancedRouteObject[];
};

type TestHarness = {
  history: History;
  router: RemixRouter;
  navigate: (href: string, opts?: NavigateOptions) => NavigationHelpers;
  pop: (n: number) => Promise<NavigationHelpers>;
  cleanup: () => void;
};

type InternalLoaderHelpers = {
  dfd: Deferred;
  stub: jest.Mock;
  abortStub: jest.Mock;
  _signal?: AbortSignal;
};

type LoaderHelpers = InternalLoaderHelpers & {
  get signal(): AbortSignal;
  resolve: (d: any) => Promise<void>;
  reject: (d: any) => Promise<void>;
};

// Helpers returned from a TestHarness.navigate call, allowing fine grained
// control and assertions over the loaders/actions
type NavigationHelpers = {
  loaders: Record<string, LoaderHelpers>;
};

// Enhanced route objects are what is passed to the router for testing,. as they
// have been enhanced with stubbed loaders and actions

// A helper that includes the Deferred and stubs for any loaders/actions for the
// route allowing fine-grained test execution

// Enhance the incoming routes by adding loaders/actions as specified and
// return the updated routes and the associated route helpers

function defer() {
  let resolve: (val?: any) => Promise<void>;
  let reject: (error?: Error) => Promise<void>;
  let promise = new Promise((res, rej) => {
    resolve = async (val: any) => {
      res(val);
      try {
        await promise;
      } catch (e) {}
    };
    reject = async (error?: Error) => {
      rej(error);
      try {
        await promise;
      } catch (e) {}
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

type SetupOpts = {
  routes: TestRouteObject[];
  initialEntries: InitialEntry[];
  initialIndex?: number;
  hydrationData?: HydrationState;
};

function setup({
  routes,
  initialEntries,
  initialIndex,
  hydrationData,
}: SetupOpts): TestHarness {
  let guid = 0;
  // Global "active" loader helpers, keyed by routeId.  "Active" indicates that
  // this is the loader which will be waited on when the route loader is called.
  // If a navigation is interrupted, we put the the new (active) navigation in
  // here so the next execution of callLoaders will use the right hooks
  // TODO: This will need to change to a guid like transition-test in order to
  // handle interruptions with the same route
  let activeLoaderHelpers = new Map<string, InternalLoaderHelpers>();
  // Deferreds for the onChange following a navigation which allows the state
  // update to flush out otherwise the assertion happens as soon as the loader
  // is resolved - downstream of callLoaders() but before update() runs
  let onChangeDfds = new Map<number, Deferred>();
  // A set of to-be-garbage-collected Deferred's to clean up at the end of a test
  let gcDfds = new Set<Deferred>();

  // Enhance routes with loaders/actions as requested that will call the
  // active navigation loader/action
  function enhanceRoutes(_routes: TestRouteObject[]) {
    return _routes.map((r) => {
      let enhancedRoute: EnhancedRouteObject = {
        ...r,
        loader: undefined,
        children: undefined,
      };
      if (r.loader) {
        enhancedRoute.loader = (args) => {
          let helpers = activeLoaderHelpers.get(r.id);
          invariant(helpers, `No loader helpers found for routeId: ${r.id}`);
          helpers.stub(args);
          helpers._signal = args.signal;
          return helpers.dfd.promise;
        };
        if (r.children) {
          enhancedRoute.children = enhanceRoutes(r.children);
        }
      }
      return enhancedRoute;
    });
  }

  let history = createMemoryHistory({ initialEntries, initialIndex });
  let router: RemixRouter = createRemixRouter({
    history,
    routes: enhanceRoutes(routes),
    hydrationData,
  });

  function getNavigationHelpers(
    href: string,
    navigationId: number
  ): NavigationHelpers {
    let onChangeDfd = defer();
    onChangeDfds.set(navigationId, onChangeDfd);
    gcDfds.add(onChangeDfd);

    let matches = router.matchRoutes(href);
    invariant(matches, `No routes matched for ${href}`);
    let matchesWithLoaders = matches.filter((m) => m.route.loader);

    // Generate helpers for all route matches that container loaders
    let loaderHelpers = matchesWithLoaders.reduce((acc, m) => {
      const routeId = m.route.id;
      // Internal methods we need access to from the route loader execution
      let internalHelpers: InternalLoaderHelpers = {
        dfd: defer(),
        stub: jest.fn(),
        abortStub: jest.fn(),
      };
      // Set the active loader so the execution of the loader waits on the
      // correct promise
      activeLoaderHelpers.set(routeId, internalHelpers);
      gcDfds.add(internalHelpers.dfd);
      return Object.assign(acc, {
        [routeId]: {
          ...internalHelpers,
          get signal() {
            return internalHelpers._signal;
          },
          // Public APIs only needed for test execution
          async resolve(v: any) {
            await internalHelpers.dfd.resolve(v);
            // Await the flushing of the navigation state update
            await onChangeDfds.get(navigationId)?.resolve();
          },
          async reject(v: any) {
            try {
              await internalHelpers.dfd.reject(v);
            } catch (e) {}
            await onChangeDfds.get(navigationId)?.resolve();
          },
        },
      });
    }, {});

    return {
      loaders: loaderHelpers,
    };
  }

  return {
    history,
    router,

    // Simulate a navigation, returning a series of helpers to manually
    // control/assert loader/actions
    navigate(href, opts) {
      let navigationId = ++guid;
      let helpers = getNavigationHelpers(href, navigationId);

      router
        .navigate(href, opts)
        .then(() => onChangeDfds.get(navigationId)?.promise);

      return helpers;
    },

    // Simulate a navigation, returning a series of helpers to manually
    // control/assert loader/actions
    async pop(n) {
      let navigationId = ++guid;
      let helpers: NavigationHelpers;
      let promise = new Promise<void>((r) => {
        let unlisten = router.onUpdate(() => {
          helpers = getNavigationHelpers(
            history.createHref(history.location),
            navigationId
          );
          unlisten();
          r();
        });
      });
      history.go(n);
      await promise;
      //@ts-ignore
      return helpers;
    },

    cleanup() {
      gcDfds.forEach((dfd) => dfd.resolve());
    },
  };
}
//#endregion

///////////////////////////////////////////////////////////////////////////////
//#region Tests
///////////////////////////////////////////////////////////////////////////////

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
        id: "tasksId",
        path: "tasks/:id",
        loader: true,
      },
    ],
  },
];

describe("a remix router", () => {
  describe("navigation", () => {
    it("navigates through a history stack without data loading", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "tasks",
            path: "tasks",
          },
          {
            id: "tasksId",
            path: "tasks/:id",
          },
        ],
        initialEntries: ["/"],
      });

      expect(t.router.state).toEqual({
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
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      t.navigate("/tasks");
      // Unsure if we can avoid this.  Without any loaders to call - there's
      // nothing to await on, but the async calls inside transition manager still
      // queue up the state update _after_ our assertion without this setImmediate
      await new Promise((r) => setImmediate(r));
      expect(t.router.state).toEqual({
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
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      t.navigate("/tasks/1", { replace: true });
      await new Promise((r) => setImmediate(r));
      expect(t.router.state).toEqual({
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
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.router.go(-1);
      await new Promise((r) => setImmediate(r));
      expect(t.router.state).toEqual({
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
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      t.navigate("/tasks?foo=bar#hash");
      // Unsure if we can avoid this.  Without any loaders to call - there's
      // nothing to await on, but the async calls inside transition manager still
      // queue up the state update _after_ our assertion without this setImmediate
      await new Promise((r) => setImmediate(r));
      expect(t.router.state).toEqual({
        action: "PUSH",
        location: {
          pathname: "/tasks",
          search: "?foo=bar",
          hash: "#hash",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location).toEqual({
        pathname: "/tasks",
        search: "?foo=bar",
        hash: "#hash",
        state: null,
        key: expect.any(String),
      });

      t.cleanup();
    });
  });

  describe("data loading", () => {
    it("starts in an idle state if no hydration data is provided", async () => {
      // Assumption is that react router will kick this off with a replace
      // navigation to the initial location
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });

      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
    });

    it("hydrates initial data", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      expect(t.router.state).toEqual({
        action: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
        },
      });
    });

    it("executes loaders on navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let nav1 = t.navigate("/tasks");
      expect(t.router.state).toEqual(
        expect.objectContaining({
          action: "POP",
          location: expect.objectContaining({ pathname: "/" }),
          transition: expect.objectContaining({
            location: expect.objectContaining({ pathname: "/tasks" }),
            state: "loading",
            type: "normalLoad",
          }),
          loaderData: {
            root: "ROOT_DATA",
          },
        })
      );
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav1.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toEqual(
        expect.objectContaining({
          action: "PUSH",
          location: expect.objectContaining({ pathname: "/tasks" }),
          transition: IDLE_TRANSITION,
          loaderData: {
            root: "ROOT_DATA",
            tasks: "TASKS_DATA",
          },
        })
      );
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      let nav2 = t.navigate("/tasks/1");
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toEqual(
        expect.objectContaining({
          action: "PUSH",
          location: expect.objectContaining({
            pathname: "/tasks/1",
          }),
          transition: IDLE_TRANSITION,
          loaderData: {
            root: "ROOT_DATA",
            tasksId: "TASKS_ID_DATA",
          },
        })
      );
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.cleanup();
    });

    it("executes loaders on replace navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      const nav = t.navigate("/tasks", { replace: true });
      expect(nav.loaders.root.stub.mock.calls.length).toBe(0);
      expect(nav.loaders.tasks.stub).toHaveBeenCalledWith({
        request: new Request("/tasks"),
        params: {},
        signal: expect.any(AbortSignal),
      });
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks");

      t.cleanup();
    });

    it("executes loaders on go navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/", "/tasks"],
        initialIndex: 0,
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      // pop forward to /tasks
      const nav2 = await t.pop(1);
      expect(nav2.loaders.root.stub.mock.calls.length).toBe(0);
      expect(nav2.loaders.tasks.stub.mock.calls.length).toBe(1);
      expect(t.history.location.pathname).toBe("/tasks");
      expect(t.router.state.location.pathname).toBe("/"); // sike!
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });

      await nav2.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.location.pathname).toBe("/tasks");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });

      t.cleanup();
    });

    it("sends proper arguments to loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let nav = t.navigate("/tasks");
      expect(nav.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("/tasks"),
        signal: expect.any(AbortSignal),
      });

      let nav2 = t.navigate("/tasks/1");
      expect(nav2.loaders.tasksId.stub).toHaveBeenCalledWith({
        params: { id: "1" },
        request: new Request("/tasks/1"),
        signal: expect.any(AbortSignal),
      });

      let nav3 = t.navigate("/tasks?foo=bar#hash");
      expect(nav3.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        // TODO: Fix this up - transition manager currently ignores hashes in createHref
        request: new Request("/tasks?foo=bar"),
        signal: expect.any(AbortSignal),
      });

      t.cleanup();
    });

    it("handles exceptions thrown from loaders", async () => {
      let t = setup({
        routes: [
          {
            id: "root",
            loader: true,
            exceptionElement: true,
            children: [
              {
                id: "index",
                index: true,
                loader: true,
              },
              {
                id: "tasks",
                path: "/tasks",
                loader: true,
                exceptionElement: true,
              },
            ],
          },
        ],
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = t.navigate("/tasks");
      await nav.loaders.tasks.reject("TASKS_ERROR");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.exception).toEqual("TASKS_ERROR");
      expect(t.router.state.exceptionBoundaryId).toEqual("tasks");

      // Throw from index, handled by root
      let nav2 = t.navigate("/");
      await nav2.loaders.index.reject("INDEX_ERROR");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.exception).toEqual("INDEX_ERROR");
      expect(t.router.state.exceptionBoundaryId).toEqual("root");

      t.cleanup();
    });

    it("handles interruptions during navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let historySpy = jest.spyOn(t.history, "push");

      let nav = t.navigate("/tasks");
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(false);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Interrupt and confirm prior loader was aborted
      let nav2 = t.navigate("/tasks/1");
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(true);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Complete second navigation
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      // Resolve first navigation - should no-op
      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      expect(historySpy.mock.calls).toEqual([
        [
          expect.objectContaining({
            pathname: "/tasks/1",
          }),
        ],
      ]);
      t.cleanup();
    });
  });
});
