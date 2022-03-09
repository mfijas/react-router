import { Action, History, Location, Path, To } from "history";
import { Action as NavigationType, parsePath } from "history";

import type { Transition } from "./transition";
import { createTransitionManager, IDLE_TRANSITION } from "./transition";
import type { RouteData, RouteMatch, RouteObject } from "./utils";
import { normalizeSearch, matchRoutes, normalizeHash } from "./utils";

////////////////////////////////////////////////////////////////////////////////
//#region REMIX ROUTER
////////////////////////////////////////////////////////////////////////////////

export interface AppState {
  // Proxied from history
  action: NavigationType;
  location: Location;
  // Proxied from prior transition manager state
  transition: Transition;
  // Potentially hydrated from server render
  loaderData: RouteData | null;
  actionData: RouteData | null;
  exception: RouteData | null;
  // SPA-transitions:
  // transition: Transition
}

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
  hydrationData?: AppState;
}

export function createRemixRouter({
  history,
  routes,
  hydrationData,
}: CreateRemixRouterOpts) {
  let router: RemixRouter;
  let updater: () => void;
  let state: AppState = {
    loaderData: null,
    actionData: null,
    exception: null,
    ...hydrationData,
    action: history.action,
    location: history.location,
    transition: IDLE_TRANSITION,
  };

  let transitionManager = createTransitionManager({
    routes,
    location: history.location,
    // TODO remove from transition manager
    loaderData: state.loaderData || {},
    actionData: state.actionData || {},
    onChange: (newState) =>
      setState({
        transition: newState.transition,
        loaderData: newState.loaderData,
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

  function startTransition(to?: To, updateHistory?: () => void) {
    let newPath = to
      ? to
      : {
          pathname: history.location.pathname,
          search: history.location.search,
          hash: history.location.hash,
        };
    try {
      let matches = router.matchRoutes(newPath);
      if (!matches) {
        throw new Response(null, { status: 404 });
      }

      // TODO: call loaders
    } catch (e) {
      throw e;
      // TODO: Set error in state
      // setState({ error: e });
    }
    updateHistory?.();
    setState({
      action: history.action,
      location: history.location,
    });
  }

  // TODO: create flattened routes

  history.listen(() => startTransition());

  router = {
    get state() {
      return state;
    },
    createHref: history.createHref,
    matchRoutes(locationArg, basename) {
      return matchRoutes(routes, locationArg, basename);
    },
    navigate(path, opts = { replace: false, state: null }) {
      let method: "replace" | "push" = opts.replace ? "replace" : "push";
      startTransition(path, () => history[method](path, opts.state));
    },
    go(n) {
      history.go(n);
    },
    onUpdate(cb) {
      updater = cb;
      // TODO Return function to unregister
    },
    // TODO: matchRoutes()
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
