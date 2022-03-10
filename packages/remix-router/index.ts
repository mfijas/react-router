import { Action, History, Location, Path, To } from "history";
import { Action as NavigationType, parsePath } from "history";

import type { DataEvent, Transition } from "./transition";
import { createTransitionManager, IDLE_TRANSITION } from "./transition";
import {
  ParamParseKey,
  Params,
  PathMatch,
  PathPattern,
  RouteData,
  RouteMatch,
  RouteObject,
} from "./utils";
import {
  generatePath,
  invariant,
  joinPaths,
  matchPath,
  matchRoutes,
  normalizePathname,
  normalizeSearch,
  normalizeHash,
  stripBasename,
  warning,
  warningOnce,
} from "./utils";

// Re-exports for router usages
export type {
  ParamParseKey,
  Params,
  PathMatch,
  PathPattern,
  RouteMatch,
  RouteObject,
};
export {
  generatePath,
  invariant,
  joinPaths,
  matchPath,
  matchRoutes,
  normalizeHash,
  normalizePathname,
  normalizeSearch,
  stripBasename,
  warning,
  warningOnce,
};

////////////////////////////////////////////////////////////////////////////////
//#region REMIX ROUTER
////////////////////////////////////////////////////////////////////////////////

export interface AppState {
  /**
   * The most recent navigation action performed
   */
  action: NavigationType;

  /**
   * The current location according to the history stack
   */
  location: Location;

  /**
   * The current transition state
   */
  transition: Transition;

  /**
   * Data from the loaders that user sees in the browser. During a transition
   * this is the "old" data, unless there are multiple pending forms, in which
   * case this may be updated as fresh data loads complete
   */
  loaderData: RouteData;

  /**
   * Holds the action data for the latest NormalPostSubmission
   */
  actionData?: RouteData;

  /**
   * Exception thrown from loader/action/render
   */
  exception?: RouteData;
}

export type HydrationState = Pick<
  AppState,
  "loaderData" | "actionData" | "exception"
>;

export interface NavigateOptions {
  replace?: boolean;
  state?: any;
}

export interface RemixRouter {
  state: AppState;
  createHref: (to: To) => string;
  matchRoutes: (
    locationArg: Partial<Location> | string,
    basename?: string
  ) => RouteMatch[] | null;
  navigate: (path: string | Path, opts?: NavigateOptions) => void;
  go: (n: number) => void;
  onUpdate: (cb: () => void) => void;
}

export interface CreateRemixRouterOpts {
  history: History;
  routes: RouteObject[];
  hydrationData?: HydrationState;
}

export function createRemixRouter({
  history,
  routes,
  hydrationData,
}: CreateRemixRouterOpts) {
  let router: RemixRouter;
  let updater: () => void;
  let state: AppState = {
    loaderData: {},
    ...hydrationData,
    action: history.action,
    location: history.location,
    transition: IDLE_TRANSITION,
  };

  // TODO: Abstract this into history top avoid window dep in transitionManager
  // function createUrl(href: string) {
  //   return new URL(href, window.location.origin);
  // }

  let transitionManager = createTransitionManager({
    routes,
    location: history.location,
    // TODO remove from transition manager
    loaderData: state.loaderData || {},
    actionData: state.actionData || {},
    // TODO - what to use as a base here?
    createUrl: (href) => new URL(href, "remix://router"),
    onChange: ({ transition, loaderData }) =>
      setState({
        transition,
        loaderData,
      }),
    onRedirect: (to, state) => router.navigate(to, { replace: true, state }),
  });

  if (!hydrationData) {
    let matches = matchRoutes(routes, history.location);
    if (matches?.some((m) => m.route.loader)) {
      transitionManager.send({
        type: "navigation",
        action: Action.Pop,
        location: history.location,
      });
    }
  }

  function setState(newState: Partial<AppState>) {
    state = {
      ...state,
      ...newState,
    };
    updater?.();
  }

  async function startTransition(event: DataEvent, updateHistory?: () => void) {
    await transitionManager.send(event);
    updateHistory?.();
    setState({
      action: history.action,
      location: history.location,
    });
  }

  history.listen(() => {
    startTransition({
      type: "navigation",
      action: Action.Pop,
      location: history.location,
    });
  });

  router = {
    get state() {
      return state;
    },
    createHref: history.createHref,
    matchRoutes(locationArg, basename) {
      return matchRoutes(routes, locationArg, basename);
    },
    navigate(path, opts = { replace: false, state: null }) {
      // TODO should remix router take over location generation from history
      // so we can create keys before handing to transition manager?
      // (for navigates only - history would handle for pop)
      let location = {
        pathname: "",
        search: "",
        hash: "",
        ...(typeof path === "string" ? parsePath(path) : path),
        state: opts.state ?? null,
        key: "",
      };
      return opts.replace
        ? startTransition(
            {
              type: "navigation",
              action: Action.Replace,
              location,
            },
            () => history.replace(path, opts.state)
          )
        : startTransition(
            {
              type: "navigation",
              action: Action.Push,
              location,
            },
            () => history.push(path, opts.state)
          );
    },
    go(n) {
      history.go(n);
    },
    onUpdate(cb) {
      updater = cb;
      // TODO Return function to unregister
    },
  };
  return router;
}
//#endregion

////////////////////////////////////////////////////////////////////////////////
//#region UTILS
////////////////////////////////////////////////////////////////////////////////

/**
 * Returns a resolved path object relative to the given pathname.
 *
 * @see https://reactrouter.com/docs/en/v6/api#resolvepath
 */
export function resolvePath(to: To, fromPathname = "/"): Path {
  let {
    pathname: toPathname,
    search = "",
    hash = "",
  } = typeof to === "string" ? parsePath(to) : to;

  let pathname = toPathname
    ? toPathname.startsWith("/")
      ? toPathname
      : resolvePathname(toPathname, fromPathname)
    : fromPathname;

  return {
    pathname,
    search: normalizeSearch(search),
    hash: normalizeHash(hash),
  };
}

function resolvePathname(relativePath: string, fromPathname: string): string {
  let segments = fromPathname.replace(/\/+$/, "").split("/");
  let relativeSegments = relativePath.split("/");

  relativeSegments.forEach((segment) => {
    if (segment === "..") {
      // Keep the root "" segment so the pathname starts at /
      if (segments.length > 1) segments.pop();
    } else if (segment !== ".") {
      segments.push(segment);
    }
  });

  return segments.length > 1 ? segments.join("/") : "/";
}

export function resolveTo(
  toArg: To,
  routePathnames: string[],
  locationPathname: string
): Path {
  let to = typeof toArg === "string" ? parsePath(toArg) : toArg;
  let toPathname = toArg === "" || to.pathname === "" ? "/" : to.pathname;

  // If a pathname is explicitly provided in `to`, it should be relative to the
  // route context. This is explained in `Note on `<Link to>` values` in our
  // migration guide from v5 as a means of disambiguation between `to` values
  // that begin with `/` and those that do not. However, this is problematic for
  // `to` values that do not provide a pathname. `to` can simply be a search or
  // hash string, in which case we should assume that the navigation is relative
  // to the current location's pathname and *not* the route pathname.
  let from: string;
  if (toPathname == null) {
    from = locationPathname;
  } else {
    let routePathnameIndex = routePathnames.length - 1;

    if (toPathname.startsWith("..")) {
      let toSegments = toPathname.split("/");

      // Each leading .. segment means "go up one route" instead of "go up one
      // URL segment".  This is a key difference from how <a href> works and a
      // major reason we call this a "to" value instead of a "href".
      while (toSegments[0] === "..") {
        toSegments.shift();
        routePathnameIndex -= 1;
      }

      to.pathname = toSegments.join("/");
    }

    // If there are more ".." segments than parent routes, resolve relative to
    // the root / URL.
    from = routePathnameIndex >= 0 ? routePathnames[routePathnameIndex] : "/";
  }

  let path = resolvePath(to, from);

  // Ensure the pathname has a trailing slash if the original to value had one.
  if (
    toPathname &&
    toPathname !== "/" &&
    toPathname.endsWith("/") &&
    !path.pathname.endsWith("/")
  ) {
    path.pathname += "/";
  }

  return path;
}

export function getToPathname(to: To): string | undefined {
  // Empty strings should be treated the same as / paths
  return to === "" || (to as Path).pathname === ""
    ? "/"
    : typeof to === "string"
    ? parsePath(to).pathname
    : to.pathname;
}
//#endregion
