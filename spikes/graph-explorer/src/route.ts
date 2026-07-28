import { Schema as S, pipe } from 'effect'
import { Route } from 'foldkit'
import { literal, r, slash, string } from 'foldkit/route'

export const SitesRoute = r('Sites')
export const SiteRoute = r('Site', { host: S.String })
export const NotFoundRoute = r('NotFound', { path: S.String })

export const AppRoute = S.Union([SitesRoute, SiteRoute, NotFoundRoute])

export type SitesRoute = typeof SitesRoute.Type
export type SiteRoute = typeof SiteRoute.Type
export type NotFoundRoute = typeof NotFoundRoute.Type
export type AppRoute = typeof AppRoute.Type

export const sitesRouter = pipe(Route.root, Route.mapTo(SitesRoute))

export const siteRouter = pipe(
  literal('site'),
  slash(string('host')),
  Route.mapTo(SiteRoute),
)

const routeParser = Route.oneOf(siteRouter, sitesRouter)

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
)
